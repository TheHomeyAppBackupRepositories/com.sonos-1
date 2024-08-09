'use strict';

const { OAuth2Driver, fetch } = require('homey-oauth2app');

module.exports = class SonosConnectDriver extends OAuth2Driver {

  async onOAuth2Init() {
    /*
     * Flow cards
     */

    // Play a Sonos Playlist
    this.homey.flow.getActionCard('cloud_play_sonos_playlist')
      .registerRunListener(async ({ device, playlist }) => {
        return device.loadPlaylist({
          playlistId: playlist.id,
        });
      })
      .getArgument('playlist')
      .registerAutocompleteListener(async (query, args) => {
        const playlists = await args.device.getPlaylists();
        return playlists.map(playlist => ({
          id: playlist.id,
          name: playlist.name,
        })).filter(playlist => {
          return playlist.name.toLowerCase().includes(query.toLowerCase());
        });
      });

    // Play a Sonos Favorite
    this.homey.flow.getActionCard('cloud_play_sonos_favorite')
      .registerRunListener(async ({ device, favorite }) => {
        return device.loadFavorite({
          favoriteId: favorite.id,
        });
      })
      .getArgument('favorite')
      .registerAutocompleteListener(async (query, args) => {
        const favorites = await args.device.getFavorites();
        return favorites.map(favorite => ({
          id: favorite.id,
          name: favorite.name,
          description: favorite.description,
          image: favorite.imageUrl,
        })).filter(favorite => {
          return favorite.name.toLowerCase().includes(query.toLowerCase());
        });
      });

    // Play an URL
    this.homey.flow.getActionCard('cloud_play_url')
      .registerRunListener(async ({ device, url }) => {
        return device.loadStreamUrl({ url });
      });

    // Set source to Line-In
    this.homey.flow.getActionCard('cloud_play_line_in')
      .registerRunListener(async ({ device }) => {
        return device.loadLineIn();
      });

    // Set source to TV
    this.homey.flow.getActionCard('cloud_play_home_theater')
      .registerRunListener(async ({ device }) => {
        return device.loadHomeTheaterPlayback();
      });

    // Set TV Power State
    this.homey.flow.getActionCard('cloud_set_home_theater_power_state')
      .registerRunListener(async ({ device, tvPowerState }) => {
        return device.setTvPowerState({
          tvPowerState,
        });
      });

    // Play an Audio Clip
    this.homey.flow.getActionCard('cloud_play_audio_clip')
      .registerRunListener(async ({ device, url, volume }) => {
        await device.loadAudioClip({
          volume,
          url,
        });
      });

    // Play an Audio Clip
    this.homey.flow.getActionCard('cloud_play_tts')
      .registerRunListener(async ({ device, text, volume }) => {
        const homeyId = await this.homey.cloud.getHomeyId();
        const language = await this.homey.i18n.getLanguage();
        await device.loadAudioClip({
          volume,
          url: `https://tts.athom.com/?lang=${language}&text=${encodeURIComponent(text)}&homey=${homeyId}`,
        });
      });

    // Play a sound
    this.homey.flow.getActionCard('cloud_play_sound')
      .registerRunListener(async ({ device, sound, volume }) => {
        return device.loadAudioClip({
          url: `https://etc.athom.com/app/com.sonos/sound/${sound.id}.mp3`,
          volume,
        });
      })
      .getArgument('sound')
      .registerAutocompleteListener(async query => {
        const res = await fetch('https://etc.athom.com/app/com.sonos/sound/index.json');
        if (!res.ok) throw new Error(res.statusText);

        const sounds = await res.json();
        return sounds.map(sound => ({
          id: sound.id,
          name: this.homey.__(sound.title),
        })).filter(sound => {
          return sound.name.toLowerCase().includes(query.toLowerCase());
        });
      });

    // Play a Soundboard sound
    this.homey.flow.getActionCard('cloud_play_soundboard')
      .registerRunListener(({ device, sound, volume }) => {
        return device.playSoundboard({ sound, volume });
      })
      .getArgument('sound')
      .registerAutocompleteListener(query => {
        return this.homey.app.soundBoard.getSoundboardSounds().then(sounds => {
          return sounds.filter(sound => {
            return sound.name.toLowerCase().includes(query.toLowerCase());
          });
        });
      });

    // Join another player's group (legacy)
    this.homey.flow.getActionCard('cloud_join_player')
      .registerRunListener(async ({ device, player }) => {
        if (!player) {
          throw new Error('Player does not exist anymore');
        }

        if (player.driver.id !== 'cloud') {
          throw new Error('Legacy player selected');
        }

        if (!player.groupId) {
          throw new Error('Other player has no group');
        }

        if (device.householdId !== player.householdId) {
          throw new Error('Other player is in different household');
        }

        await device.joinGroup({
          groupId: player.groupId,
        });

        return true;
      });

    
    this.homey.flow.getActionCard('cloud_join_household_player')
      .registerRunListener(async ({ device, player }, state) => {
        const playerDevice = this.getDeviceById(player.id);

        if (!playerDevice) {
          throw new Error('Player does not exist anymore');
        }

        if (this.id !== 'cloud') {
          throw new Error('Legacy player selected');
        }

        if (!playerDevice.groupId) {
          throw new Error('Other player has no group');
        }

        if (device.householdId !== playerDevice.householdId) {
          throw new Error('Other player is in different household');
        }

        await device.joinGroup({ 
          groupId: playerDevice.groupId 
        });
        
        return true;
      })
      .getArgument('player')
      .registerAutocompleteListener(async (query, args) => {
        return this.getDevices().filter(device => {
          return device.householdId === args.device.householdId;
        }).filter(device => {
          return device.getName().toLowerCase().includes(query.toLowerCase());
        }).map(device => { 
          return {
            name: device.getName(),
            id: device.getId(),
          }
         });
      });


    // Join another player's group
    this.homey.flow.getActionCard('cloud_leave_current_group')
      .registerRunListener(async ({ device }) => {
        if (!device.groupId) {
          throw new Error('Other player has no group');
        }

        return device.leaveCurrentGroup();
      });

    // Set group volume
    this.homey.flow.getActionCard('set_group_volume')
      .registerRunListener(async ({ device, volume }) => {
        await device.setGroupVolume({
          volume,
        });
      });
  }

  async onPairListDevices({ oAuth2Client }) {
    const result = [];

    const households = await oAuth2Client.getHouseholds();
    await Promise.all(households.map(async household => {
      const householdId = household.id;
      const { players } = await oAuth2Client.getGroups({ householdId });

      players.forEach(player => {
        this.log('Player:', player);

        const playerId = player.id;
        const capabilities = this.manifest.capabilities.slice();
        let serialNumbers = 'n/a';
        if (player.devices) {
          serialNumbers = player.devices.map(device => device.serialNumber).join(',');
        }

        if (!player.capabilities.includes('PLAYBACK')) {
          return;
        }

        if (!player.capabilities.includes('CLOUD')) {
          return;
        }

        if (player.capabilities.includes('LINE_IN')) {
          capabilities.push('sonos_line_in');
        }

        if (player.capabilities.includes('AUDIO_CLIP')) {
          capabilities.push('sonos_audio_clip');
        }

        if (player.capabilities.includes('HT_PLAYBACK')) {
          capabilities.push('sonos_ht_playback');
        }

        if (player.capabilities.includes('HT_POWER_STATE')) {
          capabilities.push('sonos_ht_power_state');
        }

        result.push({
          capabilities,
          name: player.name,
          data: {
            playerId,
            householdId,
          },
          settings: {
            serialNumbers,
          }
        });
      });
    }));

    return result;
  }
};
