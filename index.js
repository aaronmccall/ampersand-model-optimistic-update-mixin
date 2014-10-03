var _ = require('underscore');
var kisslog = require('kisslog');
var JSONDiff = require('rfc6902-simple-diff');
var JSONPointer = require('jsonpointer');
var syncMixin = require('ampersand-optimistic-sync');
var patcherMixin = require('ampersand-model-patch-mixin');

var internals = {};

var mixin = module.exports = function (_super, protoProps) {
    var baseProto = protoProps || {};
    var config = baseProto._optimisticUpdate || {};

    protoProps = _.omit(baseProto, '_optimisticUpdate');
    
    var log = kisslog(config);

    var myProto = _.extend({
        _optimisticUpdate: config,
        _invalidHandler: function (model, version, serverData) {
            log('invalidHandler called:', version, serverData);
            if (_.isObject(serverData)) {
                return model._conflictDetector(version, serverData);
            }
            var xhr = model.sync('read', model, {
                success: function (data) {
                    var serverData = model.parse(data);
                    model._conflictDetector(model._version, serverData);
                }
            });
        },
        _getDiff: function (lhs, rhs) {
            return JSONDiff(lhs, rhs);
        },
        _getOriginal: function () {
            return _.omit(this[this._patcherConfig.originalProperty], config.ignoreProps);
        },
        _sortCollections: function (current) {
            if (config.collectionSort) {
                log('sorting current collections');
                _.each(this[this._patcherConfig.collectionProperty], function (x, name) {
                    var sorter = config.collectionSort[name] || config.collectionSort.default;
                    var currentList = current[name];
                    log('sorter: %s, currentList: %o', sorter, currentList);
                    if (sorter && currentList) {
                        current[name] = _.sortBy(currentList, sorter);
                    }
                });
            }
            return current;
        },
        _getLocalOps: function (original, current) {
            if (this._ops) return this._ops;
            original = original || this._getOriginal();
            current = current || this.toJSON();
            this._sortCollections(current);
            var omit = [];
            var ops = [];
            if (config.customCompare) {
                _.each(config.customCompare, function (isEqual, name) {
                    var result = isEqual.call(this, original[name], current[name]);
                    if (!result) return;
                    if (_.isArray(result)) {
                        ops = ops.concat(result);
                    }
                    omit.push(name);
                });
            }
            original = _.omit(original, omit);
            current = _.omit(current, omit);
            return ops.concat(this._getDiff(original, current));
        },
        _getByPath: function (path, obj) {
            if (path.charAt(path.length - 1) === '-' && !obj) return null;
            obj = obj || this._getOriginal();
            try {
                return JSONPointer.get(obj, path);
            } catch (e) {
                log('JSONPointer failed:', e, path, obj);
            }
        },
        _conflictDetector: function (version, serverData) {
            if (this._version !== version) this._version = version;
            var config = this._optimisticUpdate;
            log('Preparing conflict data%s', config.autoResolve ? ' and resolving non-conflicting changes.' : '.');
            serverData = this.parse(serverData);
            var original = this._getOriginal();
            var changed = this._getDiff(original, serverData);
            var conflicts = [];
            var employeeCache = {};
            var removeClient = [];
            var removeServer = [];
            var unsaved = this._getLocalOps();
            _.each(changed, function (op, idx) {
                log('%d: op:', idx, op);
                var collision = _.findWhere(unsaved, {op: op.op, path: op.path});
                if (collision) {
                    log('found a collision between %o and %o', op, collision);

                    var bothRemoved = (op.op === 'remove' && collision.op === 'remove');
                    var sameChange = (op.op === 'replace' && op.value === collision.value);
                    var bothAppend = (op.op === 'add' && ((op.path.lastIndexOf('-')+1 ) === op.path.length));
                    // If client and server both removed something or changed it to the same value,
                    // drop both operations --> no conflict
                    if (bothRemoved || sameChange) {
                        removeServer.push(op);
                        return removeClient.push(collision);
                    }
                    if (bothAppend && config.autoResolve) {
                        return;
                    }
                } else {
                    log('no conflict');
                    if (config.autoResolve) return;
                }
                // When config.autoResolve is set to 'server', we'll apply the server's version locally.
                if (config.autoResolve === 'server') {
                    removeClient.push(collision);
                    op.clientDiscarded = true;
                    op.client = collision.value;
                    return;
                } else {
                    removeServer.push(op);
                }

                // If we've made it this far, there is a valid conflict
                var payload = {
                    client: collision,
                    server: op,
                    original: op.op === 'add' ? null : this._getByPath(op.path)
                };
                log('adding conflict:', payload);
                return conflicts.push(payload);
            }, this);
            
            if (removeClient.length) {
                log('cleaning up _ops');
                unsaved = _.difference(unsaved, removeClient);
                if (this._ops) this._ops = unsaved;
            }
            unsaved = _.map(unsaved, function (op) {
                var original = (op.op !== 'add') ? this._getByPath(op.path) : null;
                return _.extend({original: original}, op);
            }, this);
            if (removeServer.length) {
                log('cleaning up server changes');
                changed = _.difference(changed, removeServer);
            }
            if (config.autoResolve && changed.length) {
                log('auto-resolving: %o', changed);
                this._applyDiff(changed);
                if (!conflicts.length) {
                    this._conflict = {
                        resolved: this._prepResolved(changed),
                        serverState: serverData,
                        original: original,
                        unsaved: unsaved
                    };
                    log('emitting sync:conflict-autoResolved event: %o', this._conflict);
                    this.trigger('sync:conflict-autoResolved', this, this._conflict);
                    this[this._patcherConfig.originalProperty] = serverData;
                }
            }
            if (conflicts.length) {
                log('had conflicts');
                // Deal with them
                this._conflict = {
                    conflicts: conflicts,
                    serverState: serverData,
                    resolved: config.autoResolve ? this._prepResolved(changed) : [],
                    unsaved: unsaved
                };
                log('emitting sync:conflict event: %o', this._conflict);
                return this.trigger('sync:conflict', this, this._conflict);
            }
        },
        _prepResolved: function (changed) {
            log('prepping resolved ops');
            return _.map(changed, function (operation) {
                return {
                    server: _.omit(operation, 'clientDiscarded', 'client'),
                    original: this._getByPath(operation.path),
                    clientDiscarded: operation.clientDiscarded,
                    client: operation.client
                };
            }, this);
        },
        _applyDiff: function (diff) {
            log('applying diff:', diff);
            var config = this._optimisticUpdate;
            var models = this[config.modelProperty];
            var collections = this[config.collectionProperty];
            _.each(diff, function (op) {
                var pathParts = op.path.slice(1).split('/');
                var root = pathParts.shift();
                var original, child;
                if (this._isCollection(root)) {
                    if (op.op === 'add') {
                        log('adding %o to %s', op.value, root);
                        return this[root].add(op.value);
                    }
                    var index = pathParts.shift();
                    original = this._original[root][index];
                    if (original) {
                        child = this[root].get(original.id);
                    } else {
                        child = this[root].at(index);
                    }
                    if (child && op.op === 'remove') {
                        if (!pathParts.length) {
                            log('removing %o from %s', child, root);
                            return this[root].remove(child);
                        }
                        return child.unset(pathParts.shift());
                    }
                } else if (this._isModel(root)) {
                    child = this[root];
                } else if (!pathParts.length) {
                    if (op.op === 'add' || op.op === 'replace') {
                        this.set(root, op.value);
                    } else if (op.op === 'remove') {
                        this.unset(root);
                    }
                }
                if (child && op.op === 'replace') {
                    // We're replacing a single prop on the child
                    if (pathParts.length) {
                        log('setting %o property %s to %s', child, pathParts[0], op.value);
                        child.set(pathParts.shift(), op.value);
                    // We're replacing all the attributes of the child
                    } else if (_.isObject(op.value)) {
                        log('setting %o attributes to %o', child, op.value);
                        child.set(op.value);
                    }
                }
                if (child && op.op === 'remove') {
                    log('removing %o', child);
                    delete this[root];
                }
            }, this);
        },
        _isCollection: function (name) {
            var collections = this[this._patcherConfig.collectionProperty];
            return collections && name in collections;
        },
        _isModel: function (name) {
            var models = this[this._patcherConfig.modelProperty];
            return models && name in models;
        },
        // payload is the second argument to sync:conflict and 
        // sync:conflict-autoResolved handlers
        reverseUnsaved: function (payload) {
            payload = payload || this._conflict;
            var client = this._sortCollections(this.toJSON());
            var forward = this._getLocalOps(payload.original, payload.serverState);
            var reverse = this._getLocalOps(client, payload.original);
            var undo = [];
            _.each(reverse, function (op) {
                if (_.findWhere(forward, {op: op.op, path: op.path})) return;
                var clientVersion = this._getByPath(op.path, client);
                if (op.op === 'remove' && clientVersion) {
                    if (!clientVersion.id) {
                        var nodes = op.path.slice(1).split('/');
                        var collection = this[nodes[0]];
                        var model = collection.findWhere(clientVersion);
                        var index = collection.indexOf(model);
                        op.path = op.path.replace(nodes[1], index);
                        return undo.push(op);
                    } else {
                        return;
                    }
                    var serverVersion = this._getByPath(op.path, payload.serverState);
                    if (serverVersion) return;
                }
                undo.push(op);
            }, this);
            this._applyDiff(undo);
        }
    });

    var patchProto =  patcherMixin(_super, {
        _patcherConfig: config.patcher || {}
    });

    if (config.JSONPatch === false) {
        patchProto = _.omit(patchProto, '_queueOp', '_queueModelAdd', '_changeCollectionModel', 'initPatcher', 'save');
    }

    var syncProto = syncMixin(_super, _.defaults({
        invalidHandler: myProto._invalidHandler
    }, config.optimistic || {}));

    return _super.extend(_.extend(baseProto, syncProto, patchProto, myProto));
};
