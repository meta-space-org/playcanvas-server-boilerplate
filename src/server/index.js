import os from 'os';
import * as http from 'http';
import * as https from 'https';
import * as pc from 'playcanvas';
import console from './libs/logger.js';
import WebSocket from 'faye-websocket';
import deflate from './libs/permessage-deflate/permessage-deflate.js';
import { downloadAsset, updateAssets } from './libs/assets.js';

import WorkerNode from './core/worker-node.js';
import User from './core/user.js';
import performance from './libs/server-performance.js';

/**
 * @class PlayNetwork
 * @classdesc Main interface of PlayNetwork, which acts as a composer for
 * {@link WorkerNode}s. It handles socket connections, and then routes them to the
 * right {@link Node} based on message scope.
 * @extends pc.EventHandler
 * @property {number} bandwidthIn Bandwidth of incoming data in bytes per second.
 * @property {number} bandwidthOut Bandwidth of outgoing data in bytes per second.
 * @property {number} cpuLoad Current CPU load 0..1.
 * @property {number} memory Current memory usage in bytes.
 */

/**
 * @event PlayNetwork#error
 * @description Unhandled error, which relates to server start or crash of any
 * of the {@link WorkerNode}s.
 * @param {Error} error
 */

class PlayNetwork extends pc.EventHandler {
    constructor() {
        super();

        this.users = new Map();
        this.nodes = new Map();
        this.routes = {
            users: new Map(),
            rooms: new Map(),
            networkEntities: new Map()
        };

        this.idsBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
        this.idsArray = new Int32Array(this.idsBuffer);
        for (let i = 0; i < 2; i++) Atomics.store(this.idsArray, i, 1);

        process.on('uncaughtException', (err) => {
            console.error(err);
            this.fire('error', err);
            return true;
        });

        process.on('unhandledRejection', (err, promise) => {
            console.error(err);
            err.promise = promise;
            this.fire('error', err);
            return true;
        });
    }

    /**
     * @method start
     * @description Start PlayNetwork, by providing configuration parameters,
     * Level Provider (to save/load hierarchy data) and HTTP(s) server handle.
     * @async
     * @param {object} settings Object with settings for initialization.
     * @param {object} settings.nodePath Relative path to node file.
     * @param {string} settings.scriptsPath Relative path to script components.
     * @param {string} settings.templatesPath Relative path to templates.
     * @param {object} settings.server Instance of a http(s) server.
     */
    async start(settings) {
        const startTime = Date.now();

        this._validateSettings(settings);

        settings.server.on('upgrade', (req, ws, body) => {
            if (!WebSocket.isWebSocket(req)) return;

            let socket = new WebSocket(req, ws, body, [], { extensions: [deflate] });
            let user = null;

            socket.on('open', async () => { });

            socket.on('message', async (e) => {
                if (typeof e.data !== 'string') {
                    e.rawData = e.data.rawData;
                    e.data = e.data.data.toString('utf8', 0, e.data.data.length);
                } else {
                    e.rawData = e.data;
                }

                e.msg = JSON.parse(e.data);

                if (e.msg.name === '_authenticate') return socket.emit('_authenticate', e.msg.data, (err, data) => {
                    if (err || e.msg.id) socket.send(JSON.stringify({ name: e.msg.name, data: err ? { err: err.message } : data, id: e.msg.id }));
                });

                await this._onMessage(e.msg, user, (err, data) => {
                    if (err || e.msg.id) user.send(e.msg.name, err ? { err: err.message } : data, null, e.msg.id);
                });
            });

            socket.on('close', async () => {
                if (user) {
                    this.fire('disconnect', user);
                    await user.destroy();
                    this.users.delete(user.id);
                }

                socket = null;
            });

            socket.on('_authenticate', (payload, callback) => {
                if (!this.hasEvent('authenticate')) {
                    user = new User(socket);
                    this._onUserConnect(user, callback);
                } else {
                    this.fire('authenticate', user, payload, (err, userId) => {
                        if (err) {
                            callback(err);
                            socket.close();
                        } else {
                            user = new User(socket, userId);
                            this._onUserConnect(user, callback);
                        }
                    });
                }
            });
        });

        this._createNodes(settings.nodePath, settings.scriptsPath, settings.templatesPath, settings.useAmmo);

        performance.addCpuLoad(this);
        performance.addMemoryUsage(this);
        performance.addBandwidth(this);

        console.info(`${os.cpus().length} Nodes started`);
        console.info(`PlayNetwork started in ${Date.now() - startTime} ms`);
    }

    async downloadAsset(saveTo, id, token) {
        const start = Date.now();
        if (await downloadAsset(saveTo, id, token)) {
            console.info(`Asset downloaded ${id} in ${Date.now() - start} ms`);
        };
    }

    async updateAssets(directory, token) {
        const start = Date.now();
        if (await updateAssets(directory, token)) {
            console.info(`Assets updated in ${Date.now() - start} ms`);
        }
    }

    _createNodes(nodePath, scriptsPath, templatesPath, useAmmo) {
        for (let i = 0; i < os.cpus().length; i++) {
            const node = new WorkerNode(i, nodePath, scriptsPath, templatesPath, useAmmo);

            node.send('_node:init', { idsBuffer: this.idsBuffer });

            this.nodes.set(i, node);
            node.on('error', (err) => this.fire('error', err));
        }
    }

    async _onUserConnect(user, callback) {
        this.users.set(user.id, user);

        for (const node of this.nodes.values()) await user.connectToNode(node);

        user.on('_room:create', (data, callback) => {
            const node = this.nodes.get(0);
            node.send('_room:create', data, user.id, callback);
        });

        user.on('_room:join', (id, callback) => {
            const node = this.routes.rooms.get(id);
            if (!node) callback(new Error('No such room'));

            node.send('_room:join', id, user.id, callback);
        });

        user.on('_room:leave', (id, callback) => {
            const node = this.routes.rooms.get(id);
            if (!node) callback(new Error('No such room'));

            node.send('_room:leave', id, user.id, callback);
        });

        user.on('_level:save', (data, callback) => {
            const node = this.nodes.get(0);
            node.send('_level:save', data, user.id, callback);
        });

        callback(null, user.id);
        this.fire('connect', user);

        performance.connectSocket(this, user, user.socket);
    }

    async _onMessage(msg, user, callback) {
        if (this.hasEvent(msg.name)) {
            this.fire(msg.name, user, msg.data, callback);
            return;
        }

        let nodes = [];

        switch (msg.scope?.type) {
            case 'user':
                if (user.hasEvent(msg.name)) {
                    user.fire(msg.name, msg.data, callback);
                } else {
                    for (const node of this.nodes.values()) {
                        nodes.push(node);
                    }
                }
                break;
            case 'room':
                nodes = [this.routes.rooms.get(msg.scope.id)];
                break;
            case 'networkEntity':
                nodes = [this.routes.networkEntities.get(msg.scope.id)];
                break;
        }

        if (!nodes.length) return;

        for (const node of nodes) {
            node?.send('_message', msg, user.id, callback);
        }
    }

    _validateSettings(settings) {
        let error = '';

        if (!settings.scriptsPath)
            error += 'settings.scriptsPath is required\n';

        if (!settings.templatesPath)
            error += 'settings.templatesPath is required\n';

        if (!settings.server || (!(settings.server instanceof http.Server) && !(settings.server instanceof https.Server)))
            error += 'settings.server is required\n';

        if (!settings.nodePath)
            error += 'settings.nodePath is required\n';

        if (error) throw new Error(error);
    }
}

export default new PlayNetwork();
