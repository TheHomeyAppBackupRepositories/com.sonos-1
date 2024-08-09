'use strict';

const Homey = require('homey');
const { URLSearchParams } = require('url');
const { OAuth2Client, OAuth2Error, fetch } = require('homey-oauth2app');
const PromiseQueue = require('promise-queue');

const SYNC_DEBOUNCE_TIMEOUT = 2500;
const SYNC_INTERVAL = 1000 * 60 * 60; // 1h

module.exports = class SonosConnectOAuth2Client extends OAuth2Client {

  static API_URL = 'https://api.ws.sonos.com/control/api/v1';
  static TOKEN_URL = 'https://api.sonos.com/login/v3/oauth/access';
  static AUTHORIZATION_URL = 'https://api.sonos.com/login/v3/oauth';
  static SCOPES = [
    'playback-control-all',
  ];

  async onInit() {
    this.subscriptions = {
      // [householdId][groupId][namespaceId]
    };

    this._pq = new PromiseQueue(1);
    this._webhookHouseholdIds = [];
    this.onWebhookMessage = this._onWebhookMessage.bind(this);

    this._syncHouseholdGroupsBind = this._syncHouseholdGroups.bind(this);
    this._syncGroupStatusBind = this._syncGroupStatus.bind(this);
  }

  async onUninit() {
    if (this.syncGroupsDebounceTimeout) {
      this.homey.clearTimeout(this.syncGroupsDebounceTimeout);
    }

    if (this.syncGroupsInterval) {
      this.homey.clearInterval(this.syncGroupsInterval);
    }

    if (this.syncStatusDebounceTimeout) {
      this.homey.clearTimeout(this.syncStatusDebounceTimeout);
    }

    if (this.syncStatusInterval) {
      this.homey.clearInterval(this.syncStatusInterval);
    }
  }

  /*
   * OAuth2Client
   */

  async onGetTokenByCode({ code }) {
    const body = new URLSearchParams();
    body.append('grant_type', 'authorization_code');
    body.append('code', code);
    body.append('redirect_uri', this._redirectUrl);

    const headers = {};
    headers['Authorization'] = `Basic ${Buffer.from(`${this._clientId}:${this._clientSecret}`).toString('base64')}`;

    const response = await fetch(this._tokenUrl, {
      body,
      headers,
      method: 'POST',
    });
    if (!response.ok) {
      throw new Error(`Invalid Response (${response.status})`);
    }

    this._token = await this.onHandleGetTokenByCodeResponse({ response });
    return this.getToken();
  }

  async onRefreshToken() {
    const token = this.getToken();
    if (!token) {
      throw new OAuth2Error('Missing Token');
    }

    const body = new URLSearchParams();
    body.append('grant_type', 'refresh_token');
    body.append('refresh_token', token.refresh_token);

    const headers = {};
    headers['Authorization'] = `Basic ${Buffer.from(`${this._clientId}:${this._clientSecret}`).toString('base64')}`;

    const response = await fetch(this._tokenUrl, {
      body,
      headers,
      method: 'POST',
    });
    if (!response.ok) {
      throw new Error(`Invalid Response (${response.status})`);
    }

    this._token = await this.onHandleRefreshTokenResponse({ response });

    this.debug('Refreshed token!', this._token);
    this.save();

    return this.getToken();
  }

  async onHandleNotOK({
    body, status, statusText, ...props
  }) {
    if (body && body.reason) {
      return new OAuth2Error(body.reason);
    }

    if (body && body.errorCode) {
      return new OAuth2Error(body.errorCode);
    }

    return super.onHandleNotOK({
      body, status, statusText, ...props,
    });
  }

  /**
   * 'Registers' the houseHoldId so that the household Groups can be synced
   *
   * @param opts
   * @param opts.householdId
   */
  registerHouseholdId({ householdId }) {
    if (!this.subscriptions[householdId]) {
      this.subscriptions[householdId] = {};
    }

    this.syncGroupsDebounced();
  }

  /**
   * Add a 'listener' to a specific household group so that the playback status and metadata can be synced
   *
   * @param opts
   * @param opts.householdId
   * @param opts.groupId
   */
  subscribeToGroup({ householdId, groupId }) {
    this.subscriptions[householdId] = this.subscriptions[householdId] || {};
    if (!this.subscriptions[householdId][groupId]) {
      this.subscriptions[householdId][groupId] = {
        listeners: 0,
        namespaces: {

          // Subscribe to namespace: playback
          playback: this.playbackSubscribe({
            householdId,
            groupId,
          }).then(() => {
            this.log(`Subscribed to playback — group ${groupId}`);
          }).catch(err => {
            this.error('playbackSubscribe Error:', err);
          }),

          // Subscribe to namespace: playbackMetadata
          playbackMetadata: this.playbackMetadataSubscribe({
            householdId,
            groupId,
          }).then(() => {
            this.log(`Subscribed to playbackMetadata — group ${groupId}`);
          }).catch(err => {
            this.error('playbackMetadataSubscribe Error:', err);
          }),

        },
      };
    }

    // Don't run the sync if the player is not in a group
    if (groupId) {
      this._syncGroupStatusDebounced();
    }

    this.subscriptions[householdId][groupId].listeners++;
  }

  unsubscribeFromGroup({ householdId, groupId }) {
    if (!this.subscriptions[householdId]) return;
    if (!this.subscriptions[householdId][groupId]) return;

    this.subscriptions[householdId][groupId].listeners--;
    if (this.subscriptions[householdId][groupId].listeners === 0) {
      delete this.subscriptions[householdId][groupId];

      // Unsubscribe from namespace: playback
      this.playbackUnsubscribe({
        householdId,
        groupId,
      }).then(() => {
        this.log(`Unsubscribed from playback — group ${groupId}`);
      }).catch(err => {
        if (err.message === 'ERROR_RESOURCE_GONE') return;
        this.error('playbackUnsubscribe Error:', err);
      });

      // Unsubscribe from namespace: playbackMetadata
      this.playbackMetadataUnsubscribe({
        householdId,
        groupId,
      }).then(() => {
        this.log(`Unsubscribed from playbackMetadata — group ${groupId}`);
      }).catch(err => {
        if (err.message === 'ERROR_RESOURCE_GONE') return;
        this.error('playbackMetadataUnsubscribe Error:', err);
      });
    }
  }

  async registerWebhook(args) {
    return this._pq.add(() => {
      return this._registerWebhook(args);
    });
  }

  async _registerWebhook({ householdId }) {
    if (this._webhookHouseholdIds.includes(householdId)) {
      return;
    }

    if (this._webhook) {
      await this._webhook.unregister().catch(this.error);
    }

    if (!this._webhookHouseholdIds.includes(householdId)) {
      this._webhookHouseholdIds.push(householdId);
    }

    this.log('Registering webhook...');
    this._webhook = await this.homey.cloud.createWebhook(Homey.env.WEBHOOK_ID, Homey.env.WEBHOOK_SECRET, {
      $keys: this._webhookHouseholdIds,
      householdIds: this._webhookHouseholdIds,
    });
    this._webhook.on('message', this.onWebhookMessage);
    this.log('Registered webhook');
  }

  _onWebhookMessage({ headers, body }) {
    const householdId = headers['x-sonos-household-id'];
    const targetValue = headers['x-sonos-target-value'];

    this.emit('webhookEvent', { householdId, targetValue, body });
  }

  /*
   * Namespace: household
   */

  async getHouseholds() {
    return this.get({
      path: '/households',
    }).then(result => result.households);
  }

  /*
   * Namespace: groups
   */

  /**
   * Debouncer for syncing group status
   *
   * @private
   */
  syncGroupsDebounced() {
    if (this.syncGroupsInterval) {
      this.homey.clearInterval(this.syncGroupsInterval);
    }

    this.syncGroupsInterval = this.homey.setInterval(this._syncHouseholdGroupsBind, SYNC_INTERVAL);

    if (this.syncGroupsDebounceTimeout) {
      this.homey.clearTimeout(this.syncGroupsDebounceTimeout);
    }

    this.syncGroupsDebounceTimeout = this.homey.setTimeout(() => {
      this._syncHouseholdGroupsBind();
    }, SYNC_DEBOUNCE_TIMEOUT);
  }

  /**
   * Emits the Sonos Groups for each household
   *
   * @private
   */
  _syncHouseholdGroups() {
    this.log('Syncing Household Groups');
    const households = Object.keys(this.subscriptions);

    households.forEach(householdId => {
      this.getGroups({ householdId })
        .then((response) => {
          this.emit('householdGroupsEvent', { householdId, groups: response.groups, players: response.players });
        })
        .catch(err => {
          this.error('getGroups Error:', err);
        });
    });
  }

  async getGroups({ householdId }) {
    return this.get({
      path: `/households/${householdId}/groups`,
    });
  }

  async modifyGroupMembers({
    householdId, groupId, playerIdsToAdd = [], playerIdsToRemove = [],
  }) {
    return this.post({
      path: `/households/${householdId}/groups/${groupId}/groups/modifyGroupMembers`,
      json: {
        playerIdsToAdd,
        playerIdsToRemove,
      },
    });
  }

  async setGroupVolume({ householdId, groupId, volume }) {
    return this.post({
      path: `/households/${householdId}/groups/${groupId}/groupVolume`,
      json: {
        volume,
      },
    });
  }

  /*
   * Namespace: playback
   */

  /**
   * Debouncer for syncing group playback status
   *
   * @private
   */
  _syncGroupStatusDebounced() {
    if (this.syncStatusInterval) {
      this.homey.clearInterval(this.syncStatusInterval);
    }

    this.syncStatusInterval = this.homey.setInterval(this._syncGroupStatusBind, SYNC_INTERVAL);

    if (this.syncStatusDebounceTimeout) {
      this.homey.clearTimeout(this.syncStatusDebounceTimeout);
    }

    this.syncStatusDebounceTimeout = this.homey.setTimeout(() => {
      this._syncGroupStatusBind();
    }, SYNC_DEBOUNCE_TIMEOUT);
  }

  /**
   * For each household, gen all the different groups, and sync the status data for each group
   *
   * @private
   */
  _syncGroupStatus() {
    const groups = Object.keys(this.subscriptions).map(householdId => {
      return Object.keys(this.subscriptions[householdId]).map(groupId => {
        return { householdId, groupId };
      });
    }).flat();

    groups.forEach(group => {
      this._syncStatusData(group)
        .catch(this.error);
    });
  }

  async _syncStatusData({ householdId, groupId }) {
    this.log(`Sync data for householdId: ${householdId} groupId: ${groupId}`);

    await this.getPlaybackStatus({ householdId, groupId })
      .then(({
        playbackState,
        playModes,
        positionMillis,
      }) => {
        this.emit('playbackStatusEvent', {
          householdId,
          groupId,
          playbackState,
          playModes,
          positionMillis,
        });
      })
      .catch(err => {
        this.error('getPlaybackStatus Error:', err);
      });

    await this.getMetadataStatus({ householdId, groupId })
      .then(({ currentItem }) => {
        this.emit('metadataStatusEvent', {
          householdId,
          groupId,
          currentItem,
        });
      })
      .catch(err => {
        this.error('getMetadataStatus Error:', err);
      });
  }

  async getPlaybackStatus({ householdId, groupId }) {
    return this.get({
      path: `/households/${householdId}/groups/${groupId}/playback`,
    });
  }

  async play({ householdId, groupId }) {
    return this.post({
      path: `/households/${householdId}/groups/${groupId}/playback/play`,
      json: {},
    });
  }

  async pause({ householdId, groupId }) {
    return this.post({
      path: `/households/${householdId}/groups/${groupId}/playback/pause`,
      json: {},
    });
  }

  async seek({ householdId, groupId, positionMillis }) {
    return this.post({
      path: `/households/${householdId}/groups/${groupId}/playback/seek`,
      json: {
        positionMillis,
      },
    });
  }

  async seekRelative({ householdId, groupId, deltaMillis }) {
    return this.post({
      path: `/households/${householdId}/groups/${groupId}/playback/seekRelative`,
      json: {
        deltaMillis,
      },
    });
  }

  async loadLineIn({ householdId, groupId, playOnCompletion = true }) {
    return this.post({
      path: `/households/${householdId}/groups/${groupId}/playback/lineIn`,
      json: {
        playOnCompletion,
      },
    });
  }

  async setPlayModes({
    householdId, groupId, repeat, repeatOne, crossfade, shuffle,
  }) {
    return this.post({
      path: `/households/${householdId}/groups/${groupId}/playback/playMode`,
      json: {
        playModes: {
          repeat,
          repeatOne,
          crossfade,
          shuffle,
        },
      },
    });
  }

  async setShuffle({ householdId, groupId, shuffle }) {
    return this.setPlayModes({ householdId, groupId, shuffle });
  }

  async setRepeat({ householdId, groupId, repeat }) {
    return this.setPlayModes({ householdId, groupId, repeat });
  }

  async setRepeatOne({ householdId, groupId, repeatOne }) {
    return this.setPlayModes({ householdId, groupId, repeatOne });
  }

  async skipToPreviousTrack({ householdId, groupId }) {
    return this.post({
      path: `/households/${householdId}/groups/${groupId}/playback/skipToPreviousTrack`,
      json: {},
    });
  }

  async skipToNextTrack({ householdId, groupId }) {
    return this.post({
      path: `/households/${householdId}/groups/${groupId}/playback/skipToNextTrack`,
      json: {},
    });
  }

  async playbackSubscribe({ householdId, groupId }) {
    return this.post({
      path: `/households/${householdId}/groups/${groupId}/playback/subscription`,
      json: {},
    });
  }

  async playbackUnsubscribe({ householdId, groupId }) {
    return this.delete({
      path: `/households/${householdId}/groups/${groupId}/playback/subscription`,
    });
  }

  /*
   * Namespace: playbackMetadata
   */

  async getMetadataStatus({ householdId, groupId }) {
    return this.get({
      path: `/households/${householdId}/groups/${groupId}/playbackMetadata`,
    });
  }

  async playbackMetadataSubscribe({ householdId, groupId }) {
    return this.post({
      path: `/households/${householdId}/groups/${groupId}/playbackMetadata/subscription`,
      json: {},
    });
  }

  async playbackMetadataUnsubscribe({ householdId, groupId }) {
    return this.delete({
      path: `/households/${householdId}/groups/${groupId}/playbackMetadata/subscription`,
    });
  }

  /*
   * Namespace: playbackSession
   */

  async createSession({ householdId, groupId }) {
    return this.post({
      path: `/households/${householdId}/groups/${groupId}/playbackSession`,
      json: {
        appId: 'app.homey',
        appContext: 'homey',
      },
    });
  }

  async joinOrCreateSession({ householdId, groupId }) {
    return this.post({
      path: `/households/${householdId}/groups/${groupId}/playbackSession/joinOrCreate`,
      json: {
        appId: 'app.homey',
        appContext: 'homey',
      },
    });
  }

  async playbackSessionSubscribe({ sessionId }) {
    return this.post({
      path: `/playbackSessions/${sessionId}/playbackSession/subscription`,
      json: {},
    });
  }

  async playbackSessionUnsubscribe({ sessionId }) {
    return this.delete({
      path: `/playbackSessions/${sessionId}/playbackSession/subscription`,
    });
  }

  async playbackSessionLoadStreamUrl({
    sessionId,
    itemId,
    streamUrl,
    stationMetadata = { name: 'Homey' },
    playOnCompletion = true,
  }) {
    return this.post({
      path: `/playbackSessions/${sessionId}/playbackSession/loadStreamUrl`,
      json: {
        itemId,
        streamUrl,
        stationMetadata,
        playOnCompletion,
      },
    });
  }

  async playbackSessionSeek({ sessionId, itemId, positionMillis }) {
    return this.post({
      path: `/playbackSessions/${sessionId}/playbackSession/seek`,
      json: {
        itemId,
        positionMillis,
      },
    });
  }

  /*
   * Namespace: playlists
   */

  async getPlaylists({ householdId }) {
    return this.get({
      path: `/households/${householdId}/playlists`,
    }).then(result => result.playlists);
  }

  async loadPlaylist({
    householdId, groupId, playlistId, playOnCompletion = true,
  }) {
    return this.post({
      path: `/households/${householdId}/groups/${groupId}/playlists`,
      json: {
        playlistId,
        playOnCompletion,
        action: 'REPLACE',
      },
    }).then(result => result.playlists);
  }

  /*
   * Namespace: favorites
   */

  async getFavorites({ householdId }) {
    return this.get({
      path: `/households/${householdId}/favorites`,
    }).then(result => result.items);
  }

  async loadFavorite({
    householdId, groupId, favoriteId, playOnCompletion = true,
  }) {
    return this.post({
      path: `/households/${householdId}/groups/${groupId}/favorites`,
      json: {
        favoriteId,
        playOnCompletion,
        action: 'REPLACE',
      },
    }).then(result => result.playlists);
  }

  /*
   * Namespace: playerVolume
   */

  async getPlayerVolume({ playerId }) {
    return this.get({
      path: `/players/${playerId}/playerVolume`,
    });
  }

  async setPlayerVolume({ playerId, volume, muted }) {
    return this.post({
      path: `/players/${playerId}/playerVolume`,
      json: {
        volume,
        muted,
      },
    });
  }

  async playerVolumeSubscribe({ playerId }) {
    return this.post({
      path: `/players/${playerId}/playerVolume/subscription`,
      json: {},
    });
  }

  async playerVolumeUnsubscribe({ playerId }) {
    return this.delete({
      path: `/players/${playerId}/playerVolume/subscription`,
    });
  }

  /*
   * Namespace: audioClip
   */

  async loadAudioClip({
    playerId, streamUrl, volume, name = 'Homey',
  }) {
    return this.post({
      path: `/players/${playerId}/audioClip`,
      json: {
        name,
        volume,
        streamUrl,
        appId: 'app.homey',
      },
    });
  }

  /*
   * Namespace: homeTheater
   */

  async loadHomeTheaterPlayback({ playerId, tvPowerState }) {
    return this.post({
      path: `/players/${playerId}/homeTheater`,
      json: {},
    });
  }

  async setTvPowerState({ playerId, tvPowerState }) {
    return this.post({
      path: `/players/${playerId}/homeTheater/tvPowerState`,
      json: {
        tvPowerState,
      },
    });
  }

};
