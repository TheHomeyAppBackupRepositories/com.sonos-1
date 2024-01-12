'use strict';

const { OAuth2Device } = require('homey-oauth2app');
const fetch = require('node-fetch');

const VOLUME_INTERVAL = 1000 * 60 * 60; // 1h

module.exports = class SonosConnectDevice extends OAuth2Device {

  async onOAuth2Init() {
    await this.setUnavailable('Loading...');

    this.onGetAlbumArtStream = this.onGetAlbumArtStream.bind(this);

    this.onWebhook = this._onWebhook.bind(this);
    this.oAuth2Client.on('webhookEvent', this.onWebhook);

    this.onGroups = this._setGroups.bind(this);
    this.oAuth2Client.on('householdGroupsEvent', this.onGroups);

    this.onPlaybackStatus = this._setPlaybackStatus.bind(this);
    this.oAuth2Client.on('playbackStatusEvent', this.onPlaybackStatus);

    this.onMetadataStatus = this._setMetadataStatus.bind(this);
    this.oAuth2Client.on('metadataStatusEvent', this.onMetadataStatus);

    const {
      playerId,
      householdId,
    } = this.getData();

    this.playerId = playerId;
    this.householdId = householdId;
    this.groupId = null;

    this.log(this.getName(), `${playerId}@${householdId}`);

    this.registerCapabilityListener('speaker_playing', this.onCapabilitySpeakerPlaying.bind(this));
    this.registerCapabilityListener('speaker_next', this.onCapabilitySpeakerNext.bind(this));
    this.registerCapabilityListener('speaker_prev', this.onCapabilitySpeakerPrev.bind(this));
    this.registerCapabilityListener('speaker_repeat', this.onCapabilitySpeakerRepeat.bind(this));
    this.registerCapabilityListener('speaker_shuffle', this.onCapabilitySpeakerShuffle.bind(this));
    this.registerCapabilityListener('volume_set', this.onCapabilityVolumeSet.bind(this));
    this.registerCapabilityListener('volume_mute', this.onCapabilityVolumeMute.bind(this));

    // Registers household ID for the player to get the groups for the household
    this.oAuth2Client.registerHouseholdId({ householdId });

    this._syncVolume();
    this.volumeInterval = this.homey.setInterval(this._syncVolume.bind(this), VOLUME_INTERVAL);

    // Subscribe to the volume of the specific player
    this.oAuth2Client.playerVolumeSubscribe({ playerId })
      .catch(this.error);

    // Enable the receiving of webhook messages
    this.oAuth2Client.registerWebhook({
      householdId,
      playerId,
    }).catch(this.error);

    this.image = await this.homey.images.createImage();
    this.image.setUrl(null);
    await this.setAlbumArtImage(this.image);

    await this.setAvailable();
  }

  async onOAuth2Deleted() {
    const {
      playerId,
      householdId,
    } = this;

    if (this.groupId) {
      this.oAuth2Client.unsubscribeFromGroup({
        groupId: this.groupId,
        householdId,
      });
    }

    if (this.playerId) {
      this.oAuth2Client.playerVolumeUnsubscribe({ playerId })
        .catch(this.error);
    }

    if (this.volumeInterval) {
      this.homey.clearInterval(this.volumeInterval);
    }

    this.oAuth2Client.off('webhookEvent', this.onWebhook);
    this.oAuth2Client.off('householdGroupsEvent', this.onGroups);
    this.oAuth2Client.off('playbackStatusEvent', this.onPlaybackStatus);
    this.oAuth2Client.off('metadataStatusEvent', this.onMetadataStatus);
  }

  async onGetAlbumArtStream(stream) {
    if (!this.imageUrl) {
      throw new Error('Missing Image URL');
    }

    const res = await fetch(this.imageUrl);
    if (!res.ok) {
      throw new Error('Invalid Response');
    }
    return res.body.pipe(stream);
  }

  /**
   * Sync the Volume for the player
   */
  _syncVolume() {
    const {
      playerId,
    } = this;

    this.oAuth2Client.getPlayerVolume({ playerId })
      .then(({ volume, muted }) => {
        this._setPlayerVolume({ volume, muted });
      })
      .catch(err => {
        this.error('getPlayerVolume Error:', err);
      });
  }

  /**
   * Iterates over the groups list to check if the player is part of any group
   *
   * @param opts
   * @param opts.groups
   */
  _setGroups({ groups }) {
    const sonosGroup = groups.find(group => {
      return group.playerIds.includes(this.playerId);
    });

    this._setGroup({ group: sonosGroup });
  }

  /**
   * Sets the group id for the player and subscribes to events for the Group
   *
   * @param opts
   * @param opts.group
   * @private
   */
  _setGroup({ group }) {
    const {
      householdId,
    } = this;

    // If the speaker has no group
    if (!group) {
      if (this.groupId !== null) {
        // If the player was previously in a group, unsubscribe for the events
        this.oAuth2Client.unsubscribeFromGroup({
          groupId: this.groupId,
          householdId,
        });
      }

      this.groupId = null;

      if (this.hasCapability('sonos_group')) {
        this.setCapabilityValue('sonos_group', null)
          .catch(this.error);
      }

      this.log('Now in unknown group');

      return;
    }

    const {
      id: groupId,
    } = group;

    if (this.hasCapability('sonos_group')) {
      this.setCapabilityValue('sonos_group', group.name)
        .catch(this.error);
    }

    // Check if already same group, if so don't resubscribe. Also check if group was updated (moved or removed)
    // in that case do resubscribe:
    // "Subscriptions live for a maximum of three days. If a target player shuts down and does not connect back
    // within the next 30 seconds, it wipes clean any target subscriptions. If this player was part of a group
    // and the other group members stay connected while the target player is gone, one of the other group members
    // will claim the subscription. If there are any group changes, you should receive a global event indicating
    // group modifications when Sonos cleans up a subscription. Your client must also resubscribe based on any
    // response or event indicating that a group has moved or is gone."
    // From "Subscription lifetime" at https://devdocs.sonos.com/docs/subscribe.
    if (this.groupId === groupId && !this.groupWasUpdated) return;
    this.groupWasUpdated = false; // Reset group was gone flag

    // When the speaker has joined a new group

    // Unsubscribe first
    if (this.groupId) {
      this.oAuth2Client.unsubscribeFromGroup({
        groupId: this.groupId,
        householdId,
      });
    }

    this.log('Now in group:', groupId);
    this.groupId = groupId;

    this.oAuth2Client.subscribeToGroup({
      groupId,
      householdId,
    });
  }

  _setPlaybackStatus({
    householdId,
    groupId,
    playbackState,
    playModes,
    positionMillis,
  }) {
    if (this.householdId === householdId && this.groupId === groupId) {
      if (typeof playbackState !== 'undefined') {
        this._setPlaybackState(playbackState);
      }

      if (typeof playModes !== 'undefined') {
        this._setPlayModes(playModes);
      }

      if (typeof positionMillis !== 'undefined') {
        this._setPositionMillis(positionMillis);
      }
    }
  }

  _setPlaybackState(playbackState) {
    let speakerPlaying = null;
    if (playbackState === 'PLAYBACK_STATE_PLAYING') speakerPlaying = true;
    if (playbackState === 'PLAYBACK_STATE_BUFFERING') speakerPlaying = true;
    if (playbackState === 'PLAYBACK_STATE_IDLE') speakerPlaying = false;
    if (playbackState === 'PLAYBACK_STATE_PAUSED') speakerPlaying = false;

    this.setCapabilityValue('speaker_playing', speakerPlaying)
      .catch(this.error);
  }

  _setPlayModes(playModes) {
    let speakerRepeat = 'none';
    if (playModes.repeatOne) {
      speakerRepeat = 'track';
    } else if (playModes.repeat && !playModes.repeatOne) {
      speakerRepeat = 'playlist';
    }

    this.setCapabilityValue('speaker_repeat', speakerRepeat)
      .catch(this.error);
    this.setCapabilityValue('speaker_shuffle', !!playModes.shuffle)
      .catch(this.error);
  }

  _setPositionMillis(positionMillis) {
    this.setCapabilityValue('speaker_position', positionMillis / 1000)
      .catch(this.error);
  }

  _setMetadataStatus({ householdId, groupId, currentItem }) {
    if (this.householdId === householdId && this.groupId === groupId) {
      if (typeof currentItem !== 'undefined') {
        this._setCurrentItem(currentItem);
        this._setPlaybackState(false);
      } else {
        this._unsetCurrentItem();
        this._unsetPositionMillis();
      }
    }
  }

  _unsetPositionMillis() {
    this.setCapabilityValue('speaker_position', null)
      .catch(this.error);
  }

  _setPlayerVolume({ volume, muted }) {
    this.setCapabilityValue('volume_set', volume / 100)
      .catch(this.error);
    this.setCapabilityValue('volume_mute', !!muted)
      .catch(this.error);
  }

  _setCurrentItem(currentItem) {
    const {
      track,
    } = currentItem;

    const {
      name,
      imageUrl,
      album,
      artist,
      durationMillis,
    } = track;

    if (name) {
      this.setCapabilityValue('speaker_track', name)
        .catch(this.error);
    }

    if (artist && artist.name) {
      this.setCapabilityValue('speaker_artist', artist.name)
        .catch(this.error);
    }

    if (album && album.name) {
      this.setCapabilityValue('speaker_album', album.name)
        .catch(this.error);
    }

    if (durationMillis) {
      this.setCapabilityValue('speaker_duration', durationMillis / 1000);
    }

    if (this.imageUrl !== imageUrl) {
      this.imageUrl = imageUrl;

      try {
        if (typeof imageUrl === 'string' && imageUrl.startsWith('https:')) {
          this.image.setUrl(imageUrl);
        } else if (typeof imageUrl === 'string' && imageUrl.startsWith('http:')) {
          this.image.setStream(this.onGetAlbumArtStream);
        } else {
          this.image.setUrl(null);
        }
        this.image.update()
          .catch(this.error);
      } catch (err) {
        this.error(err);
      }
    }
  }

  _unsetCurrentItem() {
    this.setCapabilityValue('speaker_track', null)
      .catch(this.error);
    this.setCapabilityValue('speaker_artist', null)
      .catch(this.error);
    this.setCapabilityValue('speaker_album', null)
      .catch(this.error);
    this.setCapabilityValue('speaker_duration', null)
      .catch(this.error);

    try {
      this.image.setUrl(null);
      this.image.update()
        .catch(this.error);
    } catch (err) {
      this.error(err);
    }
  }

  _onWebhook({ householdId, targetValue, body }) {
    if (this.householdId === householdId && (this.groupId === targetValue || this.playerId === targetValue)) {
      this._onWebhookMessage(body);
    }
  }

  /**
   * Handler for the webhook messages
   * @param body
   * @private
   */
  _onWebhookMessage(body) {
    // this.log('_onWebhookMessage', JSON.stringify(body, false, 2));

    const {
      groupStatus,
      playbackState,
      playModes,
      currentItem,
      positionMillis,
      volume,
      muted,
    } = body;

    if (['GROUP_STATUS_GONE', 'GROUP_STATUS_UPDATED'].includes(groupStatus)) {
      this.log('GROUP_STATUS_GONE - GROUP_STATUS_UPDATED', body);

      // Mark group as updated (see Device#_setGroup)
      this.groupWasUpdated = true;
      this.oAuth2Client.syncGroupsDebounced();
    }

    if (typeof playbackState !== 'undefined') {
      this._setPlaybackState(playbackState);
    }

    if (typeof playModes !== 'undefined') {
      this._setPlayModes(playModes);
    }

    if (typeof currentItem !== 'undefined') {
      this._setCurrentItem(currentItem);
    }

    if (typeof positionMillis !== 'undefined') {
      this._setPositionMillis(positionMillis);
    }

    if (typeof volume !== 'undefined' || typeof muted !== 'undefined') {
      this._setPlayerVolume({ volume, muted });
    }
  }

  /*
   * Homey Capability Listeners
   */

  async onCapabilitySpeakerPlaying(value) {
    const {
      groupId,
      householdId,
    } = this;

    if (value) {
      return this.oAuth2Client.play({
        groupId,
        householdId,
      });
    }
    return this.oAuth2Client.pause({
      groupId,
      householdId,
    });
  }

  async onCapabilitySpeakerPrev() {
    const {
      groupId,
      householdId,
    } = this;

    return this.oAuth2Client.skipToPreviousTrack({
      groupId,
      householdId,
    });
  }

  async onCapabilitySpeakerNext() {
    const {
      groupId,
      householdId,
    } = this;

    return this.oAuth2Client.skipToNextTrack({
      groupId,
      householdId,
    });
  }

  async onCapabilitySpeakerShuffle(value) {
    const {
      groupId,
      householdId,
    } = this;

    return this.oAuth2Client.setShuffle({
      groupId,
      householdId,
      shuffle: !!value,
    });
  }

  async onCapabilitySpeakerRepeat(value) {
    const {
      groupId,
      householdId,
    } = this;

    const modes = {
      none: {
        repeat: false,
        repeatOne: false,
      },
      track: {
        repeat: false,
        repeatOne: true,
      },
      playlist: {
        repeat: true,
        repeatOne: false,
      },
    };

    const mode = modes[value || 'none'];

    return this.oAuth2Client.setPlayModes({
      groupId,
      householdId,
      repeat: mode.repeat,
      repeatOne: mode.repeatOne,
    });
  }

  async onCapabilityVolumeSet(value) {
    const {
      playerId,
    } = this;

    return this.oAuth2Client.setPlayerVolume({
      playerId,
      volume: value * 100,
    });
  }

  async onCapabilityVolumeMute(value) {
    const {
      playerId,
    } = this;

    return this.oAuth2Client.setPlayerVolume({
      playerId,
      muted: !!value,
    });
  }

  /*
   * Flow methods
   */
  async getPlaylists() {
    const {
      householdId,
    } = this;

    return this.oAuth2Client.getPlaylists({ householdId });
  }

  async loadPlaylist({ playlistId }) {
    const {
      householdId,
      groupId,
    } = this;

    return this.oAuth2Client.loadPlaylist({ householdId, groupId, playlistId });
  }

  async getFavorites() {
    const {
      householdId,
    } = this;

    return this.oAuth2Client.getFavorites({ householdId });
  }

  async loadFavorite({ favoriteId }) {
    const {
      householdId,
      groupId,
    } = this;

    return this.oAuth2Client.loadFavorite({ householdId, groupId, favoriteId });
  }

  async loadStreamUrl({ url }) {
    const {
      householdId,
      groupId,
    } = this;

    const { sessionId } = await this.oAuth2Client.createSession({ householdId, groupId });
    await this.oAuth2Client.playbackSessionLoadStreamUrl({
      sessionId,
      streamUrl: url,
    });
  }

  async loadLineIn() {
    const {
      householdId,
      groupId,
    } = this;

    return this.oAuth2Client.loadLineIn({ householdId, groupId });
  }

  async loadAudioClip({ url, volume }) {
    const {
      playerId,
    } = this;

    return this.oAuth2Client.loadAudioClip({
      playerId,
      volume,
      streamUrl: url,
    });
  }

  async playSoundboard({ sound, volume }) {
    const url = await this.homey.app.soundBoard.getSoundUrl({ sound });
    return this.loadAudioClip({ url, volume });
  }

  async joinGroup({ groupId }) {
    const {
      householdId,
      playerId,
    } = this;

    const result = await this.oAuth2Client.modifyGroupMembers({
      householdId,
      groupId,
      playerIdsToAdd: [
        playerId,
      ],
    });

    // Throw if playerIds array is not available in response
    if (!result || !result.group || !Array.isArray(result.group.playerIds)) {
      throw new Error(this.homey.__('oauth2.error.ADD_GROUP_INVALID_RESPONSE'));
    }

    // Throw if playerId is not included in group.playerIds (i.e. player was not added to group)
    if (result.group.playerIds.includes(playerId) === false) throw new Error(this.homey.__('oauth2.error.ADD_GROUP_FAILED'));

    await this.oAuth2Client.syncGroupsDebounced();
  }

  async leaveCurrentGroup() {
    const {
      householdId,
      groupId,
      playerId,
    } = this;

    await this.oAuth2Client.modifyGroupMembers({
      householdId,
      groupId,
      playerIdsToRemove: [
        playerId,
      ],
    });

    await this.oAuth2Client.syncGroupsDebounced();
  }

  async setGroupVolume({ volume }) {
    const {
      householdId,
      groupId,
    } = this;

    if (!groupId) {
      throw new Error('Speaker not in Group');
    }

    await this.oAuth2Client.setGroupVolume({
      householdId,
      groupId,
      volume,
    });
  }

  async loadHomeTheaterPlayback() {
    const {
      playerId,
    } = this;

    return this.oAuth2Client.loadHomeTheaterPlayback({
      playerId,
    });
  }

  async setTvPowerState({ tvPowerState }) {
    const {
      playerId,
    } = this;

    return this.oAuth2Client.setTvPowerState({
      playerId,
      tvPowerState,
    });
  }

};
