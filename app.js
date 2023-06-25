'use strict';

const { OAuth2App } = require('homey-oauth2app');

const SoundBoard = require('./lib/SoundBoard');
const SonosConnectOAuth2Client = require('./lib/SonosConnectOAuth2Client');

module.exports = class SonosApp extends OAuth2App {

  static OAUTH2_CLIENT = SonosConnectOAuth2Client;
  static OAUTH2_DEBUG = true;

  async onOAuth2Init() {
    await super.onOAuth2Init();

    const { homey } = this;
    this.soundBoard = new SoundBoard({ homey });
  }

};
