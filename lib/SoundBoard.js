'use strict';

module.exports = class SoundBoard {

  static SOUNDBOARD_APP_ID = 'com.athom.soundboard';

  constructor({ homey }) {
    this.homey = homey;
  }

  async getSoundboardApp() {
    const app = this.homey.api.getApiApp(this.constructor.SOUNDBOARD_APP_ID);

    if (!await app.getInstalled()) {
      throw new Error(this.homey.__('soundboard_not_installed'));
    }

    return app;
  }

  async getSoundboardSounds() {
    const app = await this.getSoundboardApp();
    return app.get('/');
  }

  async getSoundUrl({ sound }) {
    const { path } = sound;
    const localAddress = await this.homey.cloud.getLocalAddress();
    return `http://${localAddress}/app/${this.constructor.SOUNDBOARD_APP_ID}/${path}`.replace(/\.\//g, '');
  }

};
