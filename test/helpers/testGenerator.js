/* jshint expr:true */
var each = require('lodash.foreach');
var extend = require('lodash.assign');
var findWhere = require('lodash.findwhere');
var isEmpty = require('lodash.isempty');
var map = require('lodash.map');
var object = require('lodash.zipobject');
var omit = require('lodash.omit');
var range = require('lodash.range');
var Code = require('code');
var Lab = require('lab');
var sinon = require('sinon');
var mixin = require('../../');
var testData = require('./testData');
var expect = Code.expect;
var JSONPointer = require('JSONPointer');

module.exports = function (BaseModel, config) {
    config = config || {};
    var name = config.name;
    delete config.name;
    function getModel(_config) {
        var myConfig;
        if (_config && !isEmpty(_config)) {
            myConfig = _config;
        }
        return mixin(BaseModel, myConfig);
    }
    var lab = Lab.script();
    var describe = lab.experiment;
    var it = lab.test;
    var afterEach = lab.afterEach;
    var beforeEach = lab.beforeEach;
    describe(name + ': detects conflicts', function () {
        var MyModel = getModel({_optimisticUpdate: config});
        var instance;
        var clientData, originalData, serverData;
        beforeEach(function (done) {
            originalData = testData();
            instance = new MyModel(originalData);
            serverData = testData();
            serverData.shoes.push({
                id: 5,
                style: 'Vans',
                color: 'Brown'
            });
            clientData = testData();
            clientData.car.model = 'Fleetwood';
            done();
        });

        it('fetches updated server state if the 412 response doesn\'t include data', function (done) {
            var sync = BaseModel.prototype.sync;
            var xhr = { getResponseHeader: sinon.stub().returns('biz-baz-buz') };
            sync.reset();
            sync.yieldsTo('success', serverData, 'ok', xhr);
            sinon.spy(instance, '_conflictDetector');
            instance._invalidHandler(instance, 'foo-bar-baz');
            expect(sync.calledOnce).to.equal(true);
            expect(instance._conflictDetector.calledOnce).to.equal(true);
            done();
        });

        it('calls _conflictDetector with server state whenever it gets it', function (done) {
            var sync = BaseModel.prototype.sync;
            var xhr = { getResponseHeader: sinon.stub().returns('biz-baz-buz') };
            sync.reset();
            sync.yieldsTo('success', serverData, 'ok', xhr);
            sinon.spy(instance, '_conflictDetector');
            instance._invalidHandler(instance, 'foo-bar-baz', serverData);
            instance._invalidHandler(instance, 'foo-bar-baz');
            expect(sync.calledOnce).to.equal(true);
            expect(instance._conflictDetector.calledTwice).to.equal(true);
            done();

        });

        it('generates a diff between original and server', function (done) {
            var oldLog = console.log;
            console.log = sinon.spy();
            instance = new (getModel({_optimisticUpdate: { patcher: {debug: true} }}))(originalData);
            instance._applyDiff(instance._getDiff(originalData, clientData));
            expect(instance._ops).to.be.an.array();
            sinon.spy(instance, '_getDiff');
            instance._conflictDetector('foo-bar-baz', serverData);
            expect(instance._getDiff.called).to.equal(true);
            expect(instance._getDiff.firstCall.args).to.deep.equal([originalData, serverData]);
            console.log = oldLog;
            done();
        });

        it('generates a diff between original and client if _ops not present', function (done) {
            instance._applyDiff(instance._getDiff(originalData, clientData));
            expect(instance._ops).to.be.an.array();
            instance._ops = null;
            sinon.spy(instance, '_getDiff');
            instance._conflictDetector('foo-bar-baz', serverData);
            expect(instance._getDiff.callCount).to.equal(2);
            expect(instance._getDiff.secondCall.args).to.deep.equal([originalData, clientData]);
            done();
        });

        it('emits a sync:conflict event if there are any unresolved changes', function (done) {
            instance.on('sync:conflict', function (model, conflict) {
                expect(model).to.equal(instance);
                expect(conflict).to.be.an.object();
                done();
            });
            serverData.shoes[0].style = 'Patent';
            instance._conflictDetector('foo-bar-baz', serverData);
        });

        it('discarding colliding removes', function (done) {
            instance._optimisticUpdate.debug = 1;
            delete serverData.car;
            instance.car.destroy();
            expect(instance._ops).to.be.an.array();
            expect(instance._ops.length).to.equal(1);
            expect(omit(instance._ops[0], 'cid')).to.deep.equal({op: 'remove', path: '/car'});
            var diff = instance._getDiff(originalData, serverData);
            expect(diff).to.be.an.array();
            expect(diff.length).to.equal(2);
            instance.on('sync:conflict', function (model, conflict) {
                expect(model).to.equal(instance);
                expect(conflict).to.be.an.object();
                expect(conflict.conflicts).to.be.an.array();
                expect(conflict.conflicts.length).to.equal(1);
                expect(findWhere(conflict.conflicts, {op: 'remove'})).to.not.exist;
                done();
            });
            instance._conflictDetector('foo-bar-baz', serverData);
        });

        it('catches JSONPointer errors', function (done) {
            expect(function () { instance._getByPath('/foo', instance._getOriginal()); }).to.not.throw();
            done();
        });

        it('discards changes to same value', function (done) {
            serverData.car.model = 'Fleetwood';
            instance.car.set('model', 'Fleetwood');
            expect(instance._ops).to.be.an.array();
            expect(instance._ops.length).to.equal(1);
            expect(omit(instance._ops[0], 'cid')).to.deep.equal({op: 'replace', path: '/car/model', value: 'Fleetwood'});
            var diff = instance._getDiff(originalData, serverData);
            expect(diff).to.be.an.array();
            expect(diff.length).to.equal(2);
            instance.on('sync:conflict', function (model, conflict) {
                expect(model).to.equal(instance);
                expect(conflict).to.be.an.object();
                expect(conflict.conflicts).to.be.an.array();
                expect(conflict.conflicts.length).to.equal(1);
                expect(conflict.conflicts[0].server.op).to.not.equal('replace');
                done();
            });
            instance._conflictDetector('foo-bar-baz', serverData);
        });

        it('applies diffs to own attributes', function (done) {
            var ages = [];
            var cb = sinon.spy(function (model) {
                ages.push(model.get('age'));
            });
            instance.on('change:age', cb);
            instance._applyDiff([
                {op: 'add', path: '/age', value: 47},
                {op: 'replace', path: '/age', value: 48},
                {op: 'remove', path: '/age'}
            ]);
            expect(cb.callCount).to.equal(3);
            expect(ages).to.deep.equal([47, 48, undefined]);
            done();
        });

        it('deep applies diffs to child models', function (done) {
            var newValue = {color: 'Red', make: 'De Soto', model: 'Firestream'};
            instance._applyDiff([{op: 'replace', path: '/car', value: newValue}]);
            expect(instance.car.toJSON()).to.contain(newValue);
            instance._applyDiff([{op: 'remove', path: '/car'}]);
            expect(instance.car).to.not.exist;
            done();
        });

        it('deep applies diffs to child collections', function (done) {
            instance.shoes.add({style: 'Spats', color: 'Black on White'});
            var sortedShoes = instance._sortCollections(instance.shoes.toJSON());
            instance._applyDiff([
                {op: 'replace', path: '/shoes/0/color', value: 'Buff'},
                {op: 'remove', path: '/shoes/0/style', context: {index: 0, source: sortedShoes}},
                {op: 'remove', path: '/shoes/1', context: {index: 1, source: sortedShoes}}
            ]);
            expect(instance.shoes.at(0).get('color')).to.equal('Buff');
            expect(instance.shoes.at(1)).to.not.exist;
            done();
        });

        it('applies nothing if diff paths don\'t match', function (done) {
            instance._applyDiff([{
                op: 'add', path: '/foo/0', value: {biz: 'baz'}
            }]);
            expect(instance.foo).to.not.exist;
            done();
        });

        it('applies nothing if diff op is not supported', function (done) {
            instance._applyDiff([
                {op: 'copy', from: '/shoes/0', path: '/shoes/1'},
                {op: 'move', from: '/car', path: '/transport'}
            ]);
            expect(instance.shoes.at(1)).to.not.exist;
            done();
        });

        it('applies nothing if diff value is wrong type', function (done) {
            var cb = sinon.spy();
            instance.car.on('change', cb);
            instance._applyDiff([{op: 'replace', path: '/car', value: 'foo'}]);
            expect(cb.called).to.equal(false);
            done();
        });

        it('detects presence of child collections', function (done) {
            expect(instance._isCollection('shoes')).to.equal(true);
            expect(instance._isCollection('pants')).to.equal(false);
            instance._collections = undefined;
            expect(instance._isCollection('shoes')).to.equal(undefined);
            done();
        });

        it('detects presence of child models', function (done) {
            expect(instance._isModel('car')).to.equal(true);
            expect(instance._isModel('house')).to.equal(false);
            instance._children = undefined;
            expect(instance._isModel('car')).to.equal(undefined);
            done();
        });

        describe('local ops generator', function () {
            var instance, serverData, originalData, clientData, sort, sortBy;
            beforeEach(function (done) {
                originalData = testData();
                instance = new (getModel({
                    _optimisticUpdate: {
                        collectionSort: {
                            shoes: 'id'
                        },
                        autoResolve: true,
                        JSONPatch: false
                    }
                }))(originalData);
                serverData = testData();
                serverData.shoes.push({
                    id: 5,
                    style: 'Vans',
                    color: 'Brown'
                });
                clientData = testData();
                clientData.car.model = 'Fleetwood';
                clientData.shoes.push({
                    id: 4,
                    style: 'Wellingtons',
                    color: 'Black'
                });
                sort = sinon.spy(instance, '_sortCollections');
                done();
            });
            afterEach(function (done) {
                sort.restore();
                done();
            });

            it('sorts child collections when generating local ops', function (done) {
                var clientOps = instance._getLocalOps(originalData, clientData);
                expect(sort.called).to.equal(true);
                expect(clientOps).to.be.an.array();
                expect(clientOps.length).to.equal(2);
                instance._optimisticUpdate.collectionSort = {
                    default: null
                };
                var serverOps = instance._getLocalOps(originalData, serverData);
                expect(serverOps).to.be.an.array();
                expect(serverOps.length).to.equal(1);
                done();
            });

            it('uses custom compare functions as configured', function (done) {
                instance._optimisticUpdate.customCompare = {
                    shoes: function (lhs, rhs) {
                        return false;
                    }
                };
                var compare = sinon.spy(instance._optimisticUpdate.customCompare, 'shoes');
                instance._getLocalOps(originalData, clientData);
                expect(compare.called).to.equal(true);
                expect(compare.returned(false)).to.equal(true);
                instance._optimisticUpdate.customCompare.shoes = function () { return true; };
                compare = sinon.spy(instance._optimisticUpdate.customCompare, 'shoes');
                instance._getLocalOps(originalData, clientData);
                expect(compare.called).to.equal(true);
                expect(compare.returned(true)).to.equal(true);
                instance._optimisticUpdate.customCompare.shoes = function (rhs, lhs) { return [{op: 'remove', path: '/shoes/2'}]; };
                compare = sinon.spy(instance._optimisticUpdate.customCompare, 'shoes');
                instance._getLocalOps(originalData, clientData);
                expect(compare.called).to.equal(true);
                expect(compare.returned([{op: 'remove', path: '/shoes/2'}])).to.equal(true);
                done();
            });
        });

        describe('auto-resolves if autoResolve directive is true', function () {
            var instance, serverData, originalData, clientData, oldLog;
            beforeEach(function (done) {
                oldLog = console.log;
                console.log = sinon.spy();
                originalData = testData();
                instance = new (getModel({_optimisticUpdate: {
                                    debug: 4,
                                    autoResolve: true,
                                    JSONPatch: false,
                                    optimistic: {debug: true}
                                }}))(originalData);
                serverData = testData();
                serverData.shoes.push({
                    id: 5,
                    style: 'Vans',
                    color: 'Brown'
                });
                clientData = testData();
                clientData.car.model = 'Fleetwood';
                done();
            });
            afterEach(function (done) {
                console.log = oldLog;
                done();
            });
            
            it('applying collisionless changes and emitting sync:conflict when conflicts remain', function (done) {
                serverData.shoes[0].style = 'Patent';
                serverData.car.model = 'De Ville';
                instance.car.set('model', 'Fleetwood');
                var serverDiff = instance._getDiff(originalData, serverData);
                var clientDiff = instance._getLocalOps();
                expect(serverDiff).to.be.an.array();
                expect(serverDiff.length).to.equal(3);
                expect(clientDiff).to.be.an.array();
                expect(clientDiff.length).to.equal(1);
                instance.on('sync:conflict', function (model, conflict) {
                    expect(conflict.resolved).to.be.an.array();
                    expect(conflict.resolved.length).to.equal(2);
                    expect(conflict.resolved[1].server).to.deep.equal({
                        op: 'add',
                        path: '/shoes/' + originalData.shoes.length,
                        value: serverData.shoes[1],
                        context: {
                            index: originalData.shoes.length,
                            source: originalData.shoes
                        }
                    });
                    expect(conflict.conflicts).to.be.an.array();
                    expect(conflict.conflicts.length).to.equal(1);
                    expect(conflict.conflicts[0]).to.deep.equal(
                        {
                            client: clientDiff[0],
                            server: extend({ test: {
                                op: 'test',
                                path: '/car/model',
                                value: originalData.car.model
                            }}, findWhere(serverDiff, {path: '/car/model', op: 'replace'})),
                            original: originalData.car.model,
                            
                        }
                    );
                    done();
                });
                instance._conflictDetector('foo-bar-baz', serverData);
            });

            it('applying collisionless changes and emitting sync:conflict-autoResolved when no conflicts remain', function (done) {
                var serverDiff = instance._getDiff(originalData, serverData);
                expect(serverDiff).to.be.an.array();
                expect(serverDiff.length).to.equal(1);
                instance.on('sync:conflict-autoResolved', function (model, conflict) {
                    expect(conflict).to.be.an.object();
                    expect(conflict.resolved).to.be.an.array();
                    expect(conflict.resolved.length).to.equal(1);
                    expect(conflict.resolved[0].server).to.deep.equal({
                        op: 'add',
                        path: '/shoes/' + originalData.shoes.length,
                        value: serverData.shoes[1],
                        context: {
                            index: originalData.shoes.length,
                            source: originalData.shoes
                        }
                    });
                    expect(instance.shoes.toJSON()).to.deep.equal(serverData.shoes);
                    done();
                });
                instance._conflictDetector('foo-bar-baz', serverData);
            });

            it('auto-resolves conflicts in favor of server when config.autoResolve === "server"', function (done) {
                instance._optimisticUpdate.autoResolve = 'server';
                serverData.car.model = 'De Ville';
                instance.car.set('model', 'Fleetwood');
                instance.shoes.add({color: 'Chocolate', style: 'Loafer'});
                instance.on('sync:conflict-autoResolved', function (model, conflict) {
                    expect(conflict).to.be.an.object();
                    expect(conflict.conflicts).to.not.exist;
                    done();
                });
                instance._conflictDetector('foo-bar-baz', serverData);
            });

            it('and can reverse unsaved client-side changes', function (done) {
                instance._optimisticUpdate.autoResolve = 'server';
                instance._optimisticUpdate.collectionSort = { shoes: 'id' };
                serverData.car.model = 'De Ville';
                instance.car.set('model', 'Fleetwood');
                instance.shoes.remove(instance.shoes.at(0));
                instance.shoes.add({color: 'Chocolate', style: 'Loafer'});
                instance.shoes.add({color: 'Red', style: 'Jogger'});
                instance.set('age', 49);
                instance.on('sync:conflict-autoResolved', function (model, conflict) {
                    instance.reverseUnsaved(conflict);
                    expect(conflict).to.be.an.object();
                    expect(conflict.conflicts).to.not.exist;
                    var iData = instance._sortCollections(instance.toJSON());
                    expect(iData.car).to.deep.equal(serverData.car);
                    expect(iData.shoes).to.deep.equal(serverData.shoes);
                    done();
                });
                instance._conflictDetector('foo-bar-baz', serverData);
            });
        });
    });
    describe(name + ': pre-applies methods before extending', function () {
        var methods = object(['parse', 'save', 'sync', 'toJSON'], map(range(4), function () { return sinon.stub().returns({}); }));
        var Model;
        beforeEach(function (done) {
            Model = getModel(methods);
            done();
        });
        each(methods, function (method, name) {
            it(name + ' is pre-applied', function (done) {
                var instance = new Model();
                instance[name]({}, name === 'sync' ? instance : {});
                expect(method.called).to.equal(true);
                done();
            });
        });
    });
    return lab;
};