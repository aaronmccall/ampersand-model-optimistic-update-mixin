var defaults = require('lodash.defaults');
var difference = require('lodash.difference');
var each = require('lodash.foreach');
var extend = require('lodash.assign');
var findWhere = require('lodash.findwhere');
var intersection = require('lodash.intersection');
var indexOf = require('lodash.indexof');
var isArray = require('lodash.isarray');
var isObject = require('lodash.isobject');
var keys = require('lodash.keys');
var map = require('lodash.map');
var omit = require('lodash.omit');
var partial = require('lodash.partial');
var pick = require('lodash.pick');
var sortBy = require('lodash.sortby');
var toArray = require('lodash.toarray');

var kisslog = require('kisslog');
var JSONPointer = require('jsonpointer');
var syncMixin = require('ampersand-optimistic-sync');
var patcherMixin = require('ampersand-model-patch-mixin');
var jiff = require('jiff');

var internals = {};
var preApply = ['save', 'parse', 'sync', 'toJSON'];
var mixin = module.exports = function (_super, protoProps) {
    var baseProto = protoProps || {};
    var config = baseProto._optimisticUpdate || {};
    
    var log = kisslog(config);
    log('baseProto: %o', baseProto);
    
    protoProps = omit(baseProto, '_optimisticUpdate');

    if (intersection(keys(baseProto), preApply).length) {
        var toPreApply = pick(baseProto, preApply);
        log('preApplying methods: %o', toPreApply);
        _super = _super.extend(toPreApply);
        baseProto = omit(baseProto, preApply);
    }
    var debug = partial(log, kisslog.debug);

    var myProto = extend({
        _optimisticUpdate: config,
        _invalidHandler: function (model, version, serverData) {
            debug('invalidHandler called:', version, serverData);
            if (isObject(serverData)) {
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
            var payload = [];
            var skipChange = [];
            var ops = jiff.diff(lhs, rhs, {
                hash: function (obj) {
                    if (obj && obj.id) return obj.id;
                    return JSON.stringify(obj);
                },
                makeContext: function (index, array) {
                    return {index: index, source: array};
                }
            });
            each(ops, function (op, idx) {
                // If we've already processed this op, skip it.
                if (skipChange.indexOf(idx) !== -1) return;
                var test, nextOp;
                if (op.op !== 'test') return payload.push(op);
                nextOp = ops[idx+1];
                if (op.path === nextOp.path) {
                    debug('adding test %o to op %o', op, nextOp);
                    // Push related op to skip list
                    skipChange.push(idx+1);
                    nextOp.test = op;
                    payload.push(nextOp);
                }
            });
            return payload;
        },
        _sortCollections: function (current) {
            if (config.collectionSort) {
                debug('sorting current collections');
                each(this[this._patcherConfig.collectionProperty], function (x, name) {
                    var sorter = config.collectionSort[name] || config.collectionSort.default;
                    var currentList = current[name];
                    debug('sorter: %s, currentList: %o', sorter, currentList);
                    if (sorter && currentList) {
                        current[name] = sortBy(currentList, sorter);
                    }
                });
            }
            return current;
        },
        _getLocalOps: function (original, current) {
            if (this._ops && this._ops.length) return this._getOps();
            original = original || this._getOriginal();
            current = current || this.toJSON();
            this._sortCollections(current);
            var omitProps = [];
            var ops = [];
            if (config.customCompare) {
                each(config.customCompare, function (isEqual, name) {
                    var result = isEqual.call(this, original[name], current[name]);
                    if (!result) return;
                    if (isArray(result)) {
                        ops = ops.concat(result);
                    }
                    omitProps.push(name);
                });
            }
            original = omit(original, omitProps);
            current = omit(current, omitProps);
            return ops.concat(this._getDiff(original, current));
        },
        _getByPath: function (path, obj) {
            if (path.charAt(path.length - 1) === '-' && !obj) return null;
            obj = obj || this._getOriginal();
            return JSONPointer.get(obj, path);
        },
        _conflictDetector: function (version, serverData) {
            if (this._version !== version) this._version = version;
            var config = this._optimisticUpdate;
            debug('Preparing conflict data%s', config.autoResolve ? ' and resolving non-conflicting changes.' : '.');
            serverData = this.parse(serverData);
            var autoResolve = !!config.autoResolve;
            var serverWins = config.autoResolve === 'server';
            var original = this._getOriginal();
            var changed = this._getDiff(original, serverData);
            var client = this.toJSON();
            var conflicts = [];
            var removeClient = [];
            var removeServer = [];
            var unsaved = this._getLocalOps(original, client);
            each(changed, function (op, idx) {
                debug('%d: op:', idx, op);
                
                var collision = findWhere(unsaved, {op: op.op, path: op.path});
                if (collision) {
                    log('found a collision between %j and %j', op, collision);

                    var bothRemoved = (op.op === 'remove' && collision.op === 'remove');
                    var sameChange = (op.op === 'replace' && op.value === collision.value);
                    var bothAppend = (op.op === 'add');
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
                    debug('no conflict');
                    if (config.autoResolve) return;
                }
                // When config.autoResolve is set to 'server', we'll apply the server's version locally.
                if (config.autoResolve === 'server') {
                    removeClient.push(collision);
                    op.clientDiscarded = true;
                    op.client = collision.value;
                    log(kisslog.info, 'overwriting client change %o with %o', collision, op);
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
                debug('adding conflict:', payload);
                return conflicts.push(payload);
            }, this);
            
            if (removeClient.length) {
                debug('cleaning up _ops');
                unsaved = difference(unsaved, removeClient);
                if (this._ops) this._ops = unsaved;
            }
            unsaved = map(unsaved, function (op) {
                var original = (op.op !== 'add') ? this._getByPath(op.path) : null;
                return extend({original: original}, op);
            }, this);
            if (removeServer.length) {
                debug('cleaning up server changes: %o', removeServer);
                changed = difference(changed, removeServer);
            }
            if (config.autoResolve && changed.length) {
                debug('auto-resolving: %o', changed);
                this._applyDiff(changed);
                if (!conflicts.length) {
                    this._conflict = {
                        resolved: this._prepResolved(changed),
                        serverState: serverData,
                        original: original,
                        unsaved: unsaved
                    };
                    log(kisslog.info, 'emitting sync:conflict-autoResolved event: %o', this._conflict);
                    this.trigger('sync:conflict-autoResolved', this, this._conflict);
                    this._setOriginal(serverData);
                }
            }
            if (conflicts.length) {
                debug('had conflicts');
                // Deal with them
                this._conflict = {
                    conflicts: conflicts,
                    serverState: serverData,
                    resolved: config.autoResolve ? this._prepResolved(changed) : [],
                    unsaved: unsaved
                };
                log(kisslog.info, 'emitting sync:conflict event: %o', this._conflict);
                return this.trigger('sync:conflict', this, this._conflict);
            }
        },
        _prepResolved: function (changed) {
            debug('prepping resolved ops');
            return map(changed, function (operation) {
                return {
                    server: omit(operation, 'clientDiscarded', 'client'),
                    original: this._getByPath(operation.path),
                    clientDiscarded: operation.clientDiscarded,
                    client: operation.client
                };
            }, this);
        },
        _applyDiff: function (diff) {
            log(kisslog.info, 'applying diff:', diff);
            var config = this._optimisticUpdate;
            var models = this[config.modelProperty];
            var collections = this[config.collectionProperty];
            each(diff, function (op) {
                if (indexOf(['add', 'remove', 'replace'], op.op) === -1) {
                    return log(kisslog.warn, 'INVALID: Unsupported operation: %s', op.op);
                }
                var pathParts = op.path.slice(1).split('/');
                var root = pathParts.shift();
                var original, child;
                if (this._isCollection(root)) {
                    if (op.op === 'add') {
                        log('adding %o to %s', op.value, root);
                        return this[root].add(op.value);
                    }
                    var index = pathParts.shift();
                    original = this._getOriginal()[root][index];
                    if (original) {
                        child = this[root].get(original);
                    } else {
                        child = this._resolveCollectionOp(this[root], op, index);
                        if (!child) return log(kisslog.error, 'NOT FOUND: Could not find collection member matching %o in %o', op, this[root].toJSON());
                    }
                    if (child && op.op === 'remove') {
                        if (!pathParts.length) {
                            debug('removing %j from %s', child, root);
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
                        debug('setting %o property %s to %s', child, pathParts[0], op.value);
                        child.set(pathParts.shift(), op.value);
                    // We're replacing all the attributes of the child
                    } else if (isObject(op.value)) {
                        debug('setting %o attributes to %o', child, op.value);
                        child.set(op.value);
                    }
                }
                if (child && op.op === 'remove') {
                    debug('removing %o', child);
                    delete this[root];
                }
            }, this);
        },
        _resolveCollectionOp: function (collection, op, index) {
            var attempt;
            if (op.op === 'remove') {
                log('finding by index');
                attempt = collection.at(index);
                if (op.test) {
                    var key;
                    var same = true;
                    var test = op.test.value;
                    for (key in test) {
                        same = attempt.get(key) === test[key];
                        if (!same) break;
                    }
                    if (same) return attempt;
                    log('find by index failed');
                    attempt = collection.findWhere(test);
                    if (attempt) return attempt;
                }
            }
            if (op.context) {
                log('finding by context');
                attempt = collection.findWhere(op.context.source[op.context.index]);
                if (attempt) return attempt;
            }
            return null;
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
            if (this._ops) this._resetOps();
            var local = this._sortCollections(this.toJSON());
            debug('reversing from\n%o\n\nto %o', local, payload.serverState);
            var reverse = this._getLocalOps(local, payload.serverState);
            debug('reverse: %j', map(reverse, function (op) {
                return pick(op, 'op', 'path', 'value');
            }));
            return this._applyDiff(reverse);
        }
    });

    var patchProto =  patcherMixin(_super, {
        _patcherConfig: config.patcher || {}
    });

    myProto._getOriginal = function () {
        return omit(patchProto._getOriginal.call(this), config.ignoreProps);
    };

    var oldSave = _super.prototype.save;
    myProto.save = function (key, val, options) {
        if (this._optimisticUpdate.JSONPatch === false) return oldSave.call(this, key, val, options);
        patchProto.save.call(this, key, val, options);
    };

    var syncProto = syncMixin(_super, defaults({
        invalidHandler: myProto._invalidHandler
    }, config.optimistic || {}));

    return _super.extend(extend(baseProto, syncProto, patchProto, myProto));
};
