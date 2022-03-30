class NetworkEntities {
  constructor() {
    this._index = new Map();
  }

  get(id) {
    return this._index.get(id);
  }

  has(id) {
    return this._index.has(id);
  }

  add(networkEntity) {
    if (this.has(networkEntity.id)) return;

    this._index.set(networkEntity.id, networkEntity);

    networkEntity.entity.once('destroy', () => {
      this._index.delete(networkEntity.id);
    });
  }

}

class Player extends pc.EventHandler {
  constructor(id, user, room) {
    super();
    this.id = id;
    this.user = user;
    this.room = room;
    user.addPlayer(this);
    pn.players.set(id, this);
    this.on('_ping', data => {
      this.room.latency = data.l;
    });
    this.room.once('destroy', this.destroy, this);
  }

  get mine() {
    return this.user.me;
  }

  send(name, data, callback) {
    pn._send(name, data, 'player', this.id, callback);
  }

  destroy() {
    pn.players.delete(this.id);
    this.fire('destroy');
    this.off();
  }

}

class User extends pc.EventHandler {
  constructor(id, me) {
    super();
    this.id = id;
    this.rooms = new Set();
    this.players = new Set();
    this._playersByRoom = new Map();
    this.me = me;
    pn.users.add(this);
  }

  addPlayer(player) {
    const room = player.room;
    this.rooms.add(room);
    this.players.add(player);

    this._playersByRoom.set(room, player);

    room.once('destroy', () => this.rooms.delete(room));
    player.once('destroy', () => {
      this.rooms.delete(room);
      this.players.delete(player);

      this._playersByRoom.delete(room);

      this.fire('leave', room, player);
      if (this.me || this._playersByRoom.size > 0) return;
      this.destroy();
    });
    this.fire('join', room, player);
  }

  getPlayerByRoom(room) {
    return this._playersByRoom.get(room) || null;
  }

  destroy() {
    this.fire('destroy');
    this.off();
  }

}

class Users {
  constructor() {
    this.me = null;
    this._users = new Map();
  }

  get(id) {
    return this._users.get(id);
  }

  has(id) {
    return this._users.has(id);
  }

  add(user) {
    if (this._users.has(user.id)) return;

    this._users.set(user.id, user);

    user.once('destroy', () => this._users.delete(user.id));
    if (!user.me) return;
    this.me = user;
  }

}

class Room extends pc.EventHandler {
  constructor(id, tickrate, players) {
    super();
    this.id = id;
    this.tickrate = tickrate;
    this.players = new Set();
    this._hierarchyHandler = pc.app.loader.getHandler('hierarchy');
    this._networkEntities = new NetworkEntities();
    this.root = null;
    this.latency = 0;

    for (const key in players) {
      const {
        id,
        userData
      } = players[key];
      const user = pn.users.get(userData.id) || new User(userData.id);
      const player = new Player(id, user, this);
      this.players.add(player);
    }

    this.on('_player:join', this._onPlayerJoin, this);
    this.on('_player:leave', this._onPlayerLeave, this);
    this.on('_networkEntities:add', this._onNetworkEntityAdd, this);
    this.on('_networkEntities:create', this._onNetworkEntityCreate, this);
    this.on('_networkEntities:delete', this._onNetworkEntityDelete, this);
    this.on('_state:update', this._onUpdate, this);
  }

  send(name, data, callback) {
    pn._send(name, data, 'room', this.id, callback);
  }

  leave(callback) {
    pn.rooms.leave(this.id, callback);
  }

  _onPlayerJoin({
    id,
    userData
  }) {
    if (pn.players.has(id)) return;
    const user = pn.users.get(userData.id) || new User(userData.id);
    const player = new Player(id, user, this);
    this.players.add(player);
    player.once('destroy', () => this.players.delete(player));
    this.fire('join', player);
    pn.rooms.fire('join', this, player);
  }

  _onPlayerLeave(id) {
    if (!pn.players.has(id)) return;
    const player = pn.players.get(id);
    if (!this.players.has(player)) return;
    player.destroy();
    this.fire('leave', player);
    pn.rooms.fire('leave', this, player);
  }

  _onNetworkEntityAdd(networkEntity) {
    this._networkEntities.add(networkEntity);

    pn.networkEntities.add(networkEntity);
  }

  _onNetworkEntityCreate(data) {
    const parentIndex = new Map();

    for (const id in data.entities) {
      const parentId = data.entities[id].parent;
      if (!parentId || data.entities[parentId]) continue;
      parentIndex.set(parentId, id);
      data.entities[id].parent = null;
    }

    const entity = this._hierarchyHandler.open('', data);

    const wasEnabled = entity.enabled;
    entity.enabled = false;

    for (const [parentId, id] of parentIndex) {
      const parent = pc.app.root.findByGuid(parentId);
      const child = entity.getGuid() === id ? entity : entity.findByGuid(id);

      if (!parent) {
        console.log(`entity ${child.name} unknown parent ${parentId}`);
        continue;
      }

      parent.addChild(child);
    }

    entity.enabled = wasEnabled;
    entity.forEach(entity => {
      const networkEntity = entity?.script?.networkEntity;
      if (!networkEntity) return;

      this._networkEntities.add(networkEntity);

      pn.networkEntities.add(networkEntity);
    });
  }

  _onNetworkEntityDelete(id) {
    const networkEntity = this._networkEntities.get(id);

    if (!networkEntity) return;
    networkEntity.entity.destroy();
  }

  _onUpdate(data) {
    for (let i = 0; i < data.length; i++) {
      const id = data[i].id;

      const networkEntity = this._networkEntities.get(id);

      if (!networkEntity) continue;
      networkEntity.setState(data[i]);
    }
  }

  destroy() {
    for (const player of this.players) {
      player.destroy();
    }

    this._networkEntities = null;
    this.players = null;
    this.fire('destroy');
    this.off();
  }

}

class Rooms extends pc.EventHandler {
  constructor() {
    super();
    this._rooms = new Map();
    pn.on('_room:join', ({
      tickrate,
      players,
      level,
      state,
      id
    }) => {
      if (this.has(id)) return;
      const room = new Room(id, tickrate, players);

      this._rooms.set(id, room);

      room.once('destroy', () => this._rooms.delete(id));

      pn.levels._build(room, level);

      room.fire('_state:update', state);
    });
    pn.on('_room:leave', id => {
      const room = this._rooms.get(id);

      if (!room) return;

      pn.levels._clear(id);

      this._rooms.delete(id);

      room.destroy();
    });
  }

  create(data, callback) {
    pn.send('_room:create', data, (err, data) => {
      if (callback) callback(err, data);
    });
  }

  join(id, callback) {
    if (this.has(id)) {
      if (callback) callback(`Already joined a Room ${id}`);
      return;
    }

    pn.send('_room:join', id, (err, data) => {
      if (callback) callback(err, data);
    });
  }

  leave(id, callback) {
    if (!this.has(id)) {
      if (callback) callback(`Room ${id} does not exist`);
      return;
    }

    pn.send('_room:leave', id, (err, data) => {
      if (callback) callback(err, data);
    });
  }

  get(id) {
    return this._rooms.get(id) || null;
  }

  has(id) {
    return this._rooms.has(id);
  }

}

class Levels {
  constructor() {
    this._rootsByRoom = new Map();
    Object.defineProperty(pc.Entity.prototype, "room", {
      get: function () {
        if (!this._room) {
          let parent = this.parent;

          while (parent && !this._room) {
            if (parent._room) {
              this._room = parent._room;
              break;
            } else {
              parent = parent.parent;
            }
          }
        }

        return this._room;
      }
    });
  }

  save(sceneId, callback) {
    this._getEditorSceneData(sceneId, level => {
      pn.send('_level:save', level, callback);
    });
  }

  _build(room, level) {
    const sceneRegistryItem = new pc.SceneRegistryItem(level.name, level.item_id);
    sceneRegistryItem.data = level;
    sceneRegistryItem._loading = false;

    this._loadSceneHierarchy.call(pc.app.scenes, sceneRegistryItem, room, (_, root) => {
      this._rootsByRoom.set(room.id, root);
    });

    pc.app.scenes.loadSceneSettings(sceneRegistryItem, () => {});
  }

  _clear(roomId) {
    const root = this._rootsByRoom.get(roomId);

    if (!root) return;
    root.destroy();

    this._rootsByRoom.delete(roomId);
  }

  _getEditorSceneData(sceneId, callback) {
    pc.app.loader._handlers.scene.load(sceneId, (err, scene) => {
      if (err) {
        console.error(err);
        return;
      }

      callback(scene);
    });
  }

  _loadSceneHierarchy(sceneItem, room, callback) {
    const self = this;

    const handler = this._app.loader.getHandler("hierarchy");

    this._loadSceneData(sceneItem, false, function (err, sceneItem) {
      if (err) {
        if (callback) callback(err);
        return;
      }

      const url = sceneItem.url;
      const data = sceneItem.data;

      const _loaded = function () {
        self._app.systems.script.preloading = true;
        const entity = handler.open(url, data);
        self._app.systems.script.preloading = false;

        self._app.loader.clearCache(url, "hierarchy");

        self._app.root.addChild(entity);

        entity._room = room;
        room.root = entity;

        self._app.systems.fire('initialize', entity);

        self._app.systems.fire('postInitialize', entity);

        self._app.systems.fire('postPostInitialize', entity);

        if (callback) callback(err, entity);
      };

      self._app._preloadScripts(data, _loaded);
    });
  }

}

class InterpolateValue {
  INTERPOLATION_STATES_LIMIT = 8;

  constructor(value, object, key, setter, tickrate) {
    this.type = typeof value === 'object' ? value.constructor : null;
    this.pool = [];
    this.states = [];
    this.current = 0;
    this.time = 0;
    this.speed = 1;
    this.tickrate = tickrate;
    this.from = this.type ? value.clone() : value;
    this.value = this.type ? value.clone() : value;
    this.object = object;
    this.key = key;
    this.setter = setter;
  }

  set(value) {
    if (this.type) {
      this.from.copy(value);
      this.value.copy(value);
    } else {
      this.from = value;
      this.value = value;
    }
  }

  add(value) {
    if (this.type) {
      let vec;

      if (this.states.length > this.INTERPOLATION_STATES_LIMIT) {
        vec = this.states.shift();
      } else if (this.pool.length) {
        vec = this.pool.pop();
      } else {
        vec = new this.type();
      }

      vec.copy(value);
      this.states.push(vec);
    } else {
      this.states.push(value);
    }
  }

  update(dt) {
    if (!this.states.length) return;
    const duration = 1.0 / this.tickrate;
    let speed = 1 + Math.max(0, Math.min(10, this.states.length - 2)) * 0.01;
    this.speed += (speed - this.speed) * 0.1;
    this.time += dt * this.speed;

    if (this.time >= duration) {
      this.time -= duration;
      this.current++;

      if (this.type) {
        this.from.copy(this.value);
      } else {
        this.from = this.value;
      }

      while (this.current > 0) {
        let vec = this.states.shift();
        this.pool.push(vec);
        this.current--;
      }
    }

    if (!this.states.length) return;
    const to = this.states[this.current];
    const lerp = Math.min(1.0, this.time / duration);

    if (this.type) {
      if (this.value.slerp) {
        this.value.slerp(this.from, to, lerp);
      } else {
        this.value.lerp(this.from, to, lerp);
      }
    } else {
      this.value = this.from * lerp + this.value * (1 - lerp);
    }

    if (this.setter) {
      this.setter(this.value);
    } else if (this.object) {
      if (this.type) {
        this.object[this.key] = this.object[this.key].copy(this.value);
      } else {
        this.object[this.key] = this.value;
      }
    }
  }

}

class PlayNetwork extends pc.EventHandler {
  constructor() {
    super();
    this._lastId = 1;
    this._callbacks = new Map();
  }

  initialize() {
    this.users = new Users();
    this.rooms = new Rooms();
    this.levels = new Levels();
    this.players = new Map();
    this.networkEntities = new NetworkEntities();
    this.latency = 0;
    this.bandwidthIn = 0;
    this.bandwidthOut = 0;
    this.on('_ping', this._onPing, this);
  }

  connect(host, port, callback) {
    this.socket = new WebSocket(`wss://${host}${port ? `:${port}` : ''}/websocket`);

    this.socket.onmessage = e => this._onMessage(e.data);

    this.socket.onopen = () => {};

    this.socket.onclose = () => {
      this.latency = 0;
      this.bandwidthIn = 0;
      this.bandwidthOut = 0;
      this.fire('disconnect');
    };

    this.socket.onerror = err => {
      this.fire('error', err);
    };

    this.once('_self', data => {
      const user = new User(data.id, true);
      if (callback) callback(user);
      this.fire('connect', user);
    });
  }

  send(name, data, callback) {
    this._send(name, data, 'user', null, callback);
  }

  _send(name, data, scope, id, callback) {
    const msg = {
      name,
      scope: {
        type: scope,
        id: id
      },
      data
    };

    if (callback) {
      msg.id = this._lastId;

      this._callbacks.set(this._lastId, callback);

      this._lastId++;
    }

    this.socket.send(JSON.stringify(msg));
  }

  _onMessage(data) {
    const msg = JSON.parse(data);

    if (msg.id) {
      const callback = this._callbacks.get(msg.id);

      if (!callback) {
        console.warn(`No callback with id - ${msg.id}`);
        return;
      }

      callback(msg.data?.err || null, msg.data);

      this._callbacks.delete(msg.id);
    }

    if (msg.data?.err) {
      console.warn(msg.data.err);
      return;
    }

    if (msg.id) return;

    switch (msg.scope.type) {
      case 'user':
        this.users.me?.fire(msg.name, msg.data);
        break;

      case 'room':
        this.rooms.get(msg.scope.id)?.fire(msg.name, msg.data);
        break;

      case 'player':
        this.players.get(msg.scope.id)?.fire(msg.name, msg.data);
        break;

      case 'networkEntity':
        this.networkEntities.get(msg.scope.id)?.fire(msg.name, msg.data);
        break;
    }

    if (msg.name === '_ping') this._send('_pong', {
      id: msg.data.id
    }, msg.scope.type, msg.scope.id);
    if (msg.name === '_ping' && msg.scope !== 'user') return;
    this.fire(msg.name, msg.data);
  }

  _onPing(data) {
    this.latency = data.l;
    this.bandwidthIn = data.i || 0;
    this.bandwidthOut = data.o || 0;
  }

}

window.pn = new PlayNetwork();
window.pn.initialize();
