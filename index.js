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
            var config = this._optimisticUpdate;
            log('Preparing conflict data%s', config.autoResolve ? ' and resolving non-conflicting changes.' : '.');
            serverData = this.parse(serverData);
            var changed = this._getDiff(this._getOriginal(), serverData);
            var conflicts = [];
            var employeeCache = {};
            var removeClient = [];
            var removeServer = [];
            if (this._version !== version) this._version = version;

            _.each(changed, function (op, idx) {
                log('%d: op:', idx, op);
                var collision = _.findWhere(this._getLocalOps(), {op: op.op, path: op.path});
                if (collision) {
                    log('found a collision between %o and %o', op, collision);
                    // Remove from possible auto-resolvable changes, regardless
                    removeServer.push(op);

                    var bothRemoved = (op.op === 'remove' && collision.op === 'remove');
                    var sameChange = (op.op === 'replace' && op.value === collision.value);
                    // If client and server both removed something or changed it to the same value,
                    // drop both operations --> no conflict
                    if (bothRemoved || sameChange) {
                        return removeClient.push(collision);
                    }
                } else {
                    log('no conflict');
                    if (config.autoResolve) return;
                }

                // If we've made it this far, there is a valid conflict
                var payload = {
                    client: collision,
                    server: op,
                    original: op.op === 'add' ? null : JSONPointer.get(this._getOriginal(), op.path)
                };
                log('adding conflict:', payload);
                return conflicts.push(payload);
            }, this);
            
            if (removeClient.length && this._ops) {
                log('cleaning up _ops');
                this._ops = _.difference(this._ops, removeClient);
            }
            if (removeServer.length) {
                log('cleaning up server changes');
                changed = _.difference(changed, removeServer);
            }
            if (config.autoResolve && changed.length) {
                log('auto-resolving');
                this._applyDiff(changed);
                if (!conflicts.length) {
                    this.trigger('sync:conflict-autoResolved', this, changed);
                    this[this._patcherConfig.originalProperty] = serverData;
                }
            }
            if (conflicts.length) {
                // Deal with them
                this._conflict = {
                    conflicts: conflicts,
                    serverState: serverData,
                    resolved: this._optimisticUpdate.autoResolve ? changed : []
                };
                log('emitting sync:conflict event: %o', this._conflict);
                return this.trigger('sync:conflict', this, this._conflict);
            }
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
                        log('removing %o from %s', child, root);
                        return this[root].remove(child);
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
                    child.destroy();
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
        }
    });

    var patchProto =  patcherMixin(_super, {
        _patcherConfig: config.patcher || {}
    });

    if (config.JSONPatch === false) {
        patchProto = _.pick(patchProto, 'parse', '_patcherConfig', 'toJSON');
    }

    var syncProto = syncMixin(_super, _.defaults({
        invalidHandler: myProto._invalidHandler
    }, config.optimistic || {}));

    return _super.extend(_.extend(baseProto, syncProto, patchProto, myProto));
};
