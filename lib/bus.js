const EventEmitter = require('events').EventEmitter;
const constants = require('./constants');
const stdDbusIfaces = require('./stdifaces');
const introspect = require('./introspect');

class DBusObject {
  constructor(name, service) {
    this.name = name;
    this.service = service;
  }

  as(name) {
    return this.proxy[name];
  }
}

class DBusService {
  constructor(name, bus) {
    this.name = name;
    this.bus = bus;
  }

  getObject(name, callback) {
    const obj = new DBusObject(name, this);
    introspect(obj, (err, ifaces, nodes) => {
      if (err) return callback(err);
      obj.proxy = ifaces;
      obj.nodes = nodes;
      callback(null, obj);
    });
  }

  getInterface(objName, ifaceName, callback) {
    this.getObject(objName, (err, obj) => {
      if (err) return callback(err);
      callback(null, obj.as(ifaceName));
    });
  }
}

module.exports = class Bus {
  constructor(conn, opts) {
    if (!(this instanceof Bus)) {
      return new Bus(conn);
    }
    if (!opts) opts = {};

    this.connection = conn;
    this.serial = 1;
    this.cookies = {}; // TODO: rename to methodReturnHandlers
    this.methodCallHandlers = {};
    this.signals = new EventEmitter();
    this.exportedObjects = {};

    // register name
    if (opts.direct !== true) {
      this.invokeDbus({ member: 'Hello' }, (err, name) => {
        if (err) throw new Error(err);
        this.name = name;
      });
    } else {
      this.name = null;
    }

    // route reply/error
    this.connection.on('message', msg => {
      let handler;
      if (
        msg.type === constants.messageType.methodReturn ||
        msg.type === constants.messageType.error
      ) {
        handler = this.cookies[msg.replySerial];
        if (handler) {
          delete this.cookies[msg.replySerial];
          var props = {
            connection: this.connection,
            bus: this,
            message: msg,
            signature: msg.signature
          };
          var args = msg.body || [];
          if (msg.type === constants.messageType.methodReturn) {
            args = [null].concat(args); // first argument - no errors, null
            handler.apply(props, args); // body as array of arguments
          } else {
            handler.call(props, args); // body as first argument
          }
        }
      } else if (msg.type === constants.messageType.signal) {
        this.signals.emit(this.mangle(msg), msg.body, msg.signature);
      } else {
        // methodCall

        if (stdDbusIfaces(msg, this)) return;

        // exported interfaces handlers
        var obj, iface, impl;
        if ((obj = this.exportedObjects[msg.path])) {
          if ((iface = obj[msg['interface']])) {
            // now we are ready to serve msg.member
            impl = iface[1];
            var func = impl[msg.member];
            if (!func) {
              this.sendError(
                msg,
                'org.freedesktop.DBus.Error.UnknownMethod',
                `Method "${msg.member}" on interface "${
                  msg.interface
                }" doesn't exist`
              );
              return;
            }
            var methodReturnResult;
            try {
              methodReturnResult = func.apply(impl, msg.body);
            } catch (e) {
              this.sendError(
                msg,
                e.dbusName || 'org.freedesktop.DBus.Error.Failed',
                e.message || ''
              );
              return;
            }
            // TODO safety check here
            var resultSignature = iface[0].methods[msg.member][1];
            var methodReturnReply = {
              type: constants.messageType.methodReturn,
              destination: msg.sender,
              replySerial: msg.serial
            };
            if (methodReturnResult !== null) {
              methodReturnReply.signature = resultSignature;
              methodReturnReply.body = [methodReturnResult];
            }
            this.connection.message(methodReturnReply);
            return;
          } else {
            console.error(`Interface ${msg['interface']} is not supported`);
            // TODO: respond with standard dbus error
          }
        }
        // setMethodCall handlers
        handler = this.methodCallHandlers[this.mangle(msg)];
        if (handler) {
          var methodCallResult;
          try {
            methodCallResult = handler[0].apply(null, msg.body);
          } catch (e) {
            console.error(
              'Caught exception while trying to execute handler: ',
              e
            );
            this.sendError(e.message, e.description);
            return;
          }
          var methodCallReply = {
            type: constants.messageType.methodReturn,
            destination: msg.sender,
            replySerial: msg.serial
          };
          if (methodCallResult) {
            methodCallReply.signature = handler[1];
            methodCallReply.body = methodCallResult;
          }
          this.connection.message(methodCallReply);
        } else {
          this.sendError(
            msg,
            'org.freedesktop.DBus.Error.UnknownService',
            'Uh oh oh'
          );
        }
      }
    });
  }

  invoke(msg, callback) {
    if (!msg.type) msg.type = constants.messageType.methodCall;
    msg.serial = this.serial;
    this.serial++;
    this.cookies[msg.serial] = callback;
    this.connection.message(msg);
  }

  invokeDbus(msg, callback) {
    if (!msg.path) msg.path = '/org/freedesktop/DBus';
    if (!msg.destination) msg.destination = 'org.freedesktop.DBus';
    if (!msg.interface) msg.interface = 'org.freedesktop.DBus';
    this.invoke(msg, callback);
  }

  mangle(path, iface, member) {
    const obj = {};
    if (typeof path === 'object') {
      // handle one argumant case mangle(msg)
      obj.path = path.path;
      obj.interface = path.interface;
      obj.member = path.member;
    } else {
      obj.path = path;
      obj['interface'] = iface;
      obj.member = member;
    }
    return JSON.stringify(obj);
  }

  sendSignal(path, iface, name, signature, args) {
    const signalMsg = {
      type: constants.messageType.signal,
      serial: this.serial,
      interface: iface,
      path: path,
      member: name
    };
    if (signature) {
      signalMsg.signature = signature;
      signalMsg.body = args;
    }
    this.connection.message(signalMsg);
  }

  // Warning: errorName must respect the same rules as interface names (must contain a dot)
  sendError(msg, errorName, errorText) {
    const reply = {
      type: constants.messageType.error,
      replySerial: msg.serial,
      destination: msg.sender,
      errorName: errorName,
      signature: 's',
      body: [errorText]
    };
    this.connection.message(reply);
  }

  sendReply(msg, signature, body) {
    const reply = {
      type: constants.messageType.methodReturn,
      replySerial: msg.serial,
      destination: msg.sender,
      signature: signature,
      body: body
    };
    this.connection.message(reply);
  }

  setMethodCallHandler(objectPath, iface, member, handler) {
    const key = this.mangle(objectPath, iface, member);
    this.methodCallHandlers[key] = handler;
  }

  exportInterface(obj, path, iface) {
    var entry;
    if (!this.exportedObjects[path]) {
      entry = this.exportedObjects[path] = {};
    } else {
      entry = this.exportedObjects[path];
    }
    entry[iface.name] = [iface, obj];
    // monkey-patch obj.emit()
    if (typeof obj.emit === 'function') {
      var oldEmit = obj.emit;
      obj.emit = () => {
        var args = Array.prototype.slice.apply(arguments);
        var signalName = args[0];
        if (!signalName) throw new Error('Trying to emit undefined signa');

        //send signal to bus
        var signal;
        if (iface.signals && iface.signals[signalName]) {
          signal = iface.signals[signalName];
          var signalMsg = {
            type: constants.messageType.signal,
            serial: this.serial,
            interface: iface.name,
            path: path,
            member: signalName
          };
          if (signal[0]) {
            signalMsg.signature = signal[0];
            signalMsg.body = args.slice(1);
          }
          this.connection.message(signalMsg);
          this.serial++;
        }
        // note that local emit is likely to be called before signal arrives
        // to remote subscriber
        oldEmit.apply(obj, args);
      };
    }
    // TODO: emit ObjectManager's InterfaceAdded
  }

  getService(name) {
    return new DBusService(name, this);
  }

  getObject(path, name, callback) {
    const service = this.getService(path);
    return service.getObject(name, callback);
  }

  getInterface(path, objname, name, callback) {
    return this.getObject(path, objname, (err, obj) => {
      if (err) return callback(err);
      callback(null, obj.as(name));
    });
  }

  // TODO: refactor

  // bus meta functions
  addMatch(match, callback) {
    this.invokeDbus(
      { member: 'AddMatch', signature: 's', body: [match] },
      callback
    );
  }

  removeMatch(match, callback) {
    this.invokeDbus(
      { member: 'RemoveMatch', signature: 's', body: [match] },
      callback
    );
  }

  getId(callback) {
    this.invokeDbus({ member: 'GetId' }, callback);
  }

  requestName(name, flags, callback) {
    this.invokeDbus(
      { member: 'RequestName', signature: 'su', body: [name, flags] },
      (err, name) => {
        if (callback) callback(err, name);
      }
    );
  }

  releaseName(name, callback) {
    this.invokeDbus(
      { member: 'ReleaseName', signature: 's', body: [name] },
      callback
    );
  }

  listNames(callback) {
    this.invokeDbus({ member: 'ListNames' }, callback);
  }

  listActivatableNames(callback) {
    this.invokeDbus({ member: 'ListActivatableNames' }, callback);
  }

  updateActivationEnvironment(env, callback) {
    this.invokeDbus(
      {
        member: 'UpdateActivationEnvironment',
        signature: 'a{ss}',
        body: [env]
      },
      callback
    );
  }

  startServiceByName(name, flags, callback) {
    this.invokeDbus(
      { member: 'StartServiceByName', signature: 'su', body: [name, flags] },
      callback
    );
  }

  getConnectionUnixUser(name, callback) {
    this.invokeDbus(
      { member: 'GetConnectionUnixUser', signature: 's', body: [name] },
      callback
    );
  }

  getConnectionUnixProcessId(name, callback) {
    this.invokeDbus(
      { member: 'GetConnectionUnixProcessID', signature: 's', body: [name] },
      callback
    );
  }

  getNameOwner(name, callback) {
    this.invokeDbus(
      { member: 'GetNameOwner', signature: 's', body: [name] },
      callback
    );
  }

  nameHasOwner(name, callback) {
    this.invokeDbus(
      { member: 'NameHasOwner', signature: 's', body: [name] },
      callback
    );
  }
};
