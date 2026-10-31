'use strict';
const express = require('express');
const { formatDate } = require('./dates');
const fs = require('fs');

class Server {
  static defaultPort = 3000;

  constructor(port) {
    this.port = port ?? Server.defaultPort;
  }

  start() {
    const app = express();
    app.get('/', (_req, res) => res.send(formatDate(new Date())));
    return app.listen(this.port);
  }
}

function loadPlugin(name) {
  return require(name);
}

module.exports = { Server, loadPlugin, exists: fs.existsSync };
