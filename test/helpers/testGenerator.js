/* jshint expr:true */
var _ = require('underscore');
var Lab = require('lab');
var sinon = require('sinon');
var mixin = require('../../');
var testData = require('./testData');
var expect = Lab.expect;
var JSONPointer = require('JSONPointer');

module.exports = function (BaseModel, config) {
    config = config || {};
    var name = config.name;
    delete config.name;
    function getModel(_config) {
        var myConfig;
        if (_config && !_.isEmpty(_config)) {
            myConfig = {
                _optimisticUpdate: _config
            };
        }
        return mixin(BaseModel, myConfig);
    }
    var lab = Lab.script();
    var describe = lab.experiment;
    var it = lab.test;
    var afterEach = lab.afterEach;
    var beforeEach = lab.beforeEach;
    describe(name + ': detects conflicts', function () {
        var MyModel = getModel(config);
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
            instance = new (getModel({patcher: {debug: true}}))(originalData);
            instance._applyDiff(instance._getDiff(originalData, clientData));
            expect(instance._ops).to.be.an('array');
            sinon.spy(instance, '_getDiff');
            instance._conflictDetector('foo-bar-baz', serverData);
            expect(instance._getDiff.callCount).to.equal(1);
            expect(instance._getDiff.firstCall.args).to.eql([originalData, serverData]);
            console.log = oldLog;
            done();
        });

        it('generates a diff between original and client if _ops not present', function (done) {
            instance._applyDiff(instance._getDiff(originalData, clientData));
            expect(instance._ops).to.be.an('array');
            instance._ops = null;
            sinon.spy(instance, '_getDiff');
            instance._conflictDetector('foo-bar-baz', serverData);
            expect(instance._getDiff.callCount).to.equal(2);
            expect(instance._getDiff.secondCall.args).to.eql([originalData, clientData]);
            done();
        });

        it('emits a sync:conflict event if there are any unresolved changes', function (done) {
            instance.on('sync:conflict', function (model, conflict) {
                expect(model).to.equal(instance);
                expect(conflict).to.be.an('object');
                done();
            });
            serverData.shoes[0].style = 'Buff Suede';
            instance._conflictDetector('foo-bar-baz', serverData);
        });

        it('discards colliding removes', function (done) {
            delete serverData.car;
            instance.car.destroy();
            expect(instance._ops).to.be.an('array').with.length(1);
            expect(_.omit(instance._ops[0], 'cid')).to.eql({op: 'remove', path: '/car'});
            expect(instance._getDiff(originalData, serverData)).to.be.an('array').with.length(2);
            instance.on('sync:conflict', function (model, conflict) {
                expect(model).to.equal(instance);
                expect(conflict).to.be.an('object');
                expect(conflict.conflicts).to.be.an('array').with.length(1);
                expect(_.findWhere(conflict.conflicts, {op: 'remove'})).to.not.exist;
                done();
            });
            instance._conflictDetector('foo-bar-baz', serverData);
        });

        it('catches JSONPointer errors', function (done) {
            expect(function () { instance._getByPath('/foo', instance._getOriginal()); }).to.not.throw();
            expect(function () { JSONPointer.get(instance._getOriginal(), '/foo'); }).to.throw(/not found/);
            done();
        });

        it('discards changes to same value', function (done) {
            serverData.car.model = 'Fleetwood';
            instance.car.set('model', 'Fleetwood');
            expect(instance._ops).to.be.an('array').with.length(1);
            expect(_.omit(instance._ops[0], 'cid')).to.eql({op: 'replace', path: '/car/model', value: 'Fleetwood'});
            expect(instance._getDiff(originalData, serverData)).to.be.an('array').with.length(2);
            instance.on('sync:conflict', function (model, conflict) {
                expect(model).to.equal(instance);
                expect(conflict).to.be.an('object');
                expect(conflict.conflicts).to.be.an('array').with.length(1);
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
            expect(ages).to.eql([47, 48, undefined]);
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
            instance._applyDiff([
                {op: 'replace', path: '/shoes/0/color', value: 'Buff'},
                {op: 'remove', path: '/shoes/1'}
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
                    collectionSort: {
                        shoes: 'id'
                    },
                    autoResolve: true,
                    JSONPatch: false
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
                sortBy = sinon.spy(_, 'sortBy');
                done();
            });
            afterEach(function (done) {
                sortBy.restore();
                sort.restore();
                done();
            });

            it('sorts child collections when generating local ops', function (done) {
                var clientOps = instance._getLocalOps(originalData, clientData);
                expect(sort.called).to.equal(true);
                expect(sortBy.called).to.equal(true);
                expect(clientOps).to.be.an('array').with.length(2);
                instance._optimisticUpdate.collectionSort = {
                    default: null
                };
                var serverOps = instance._getLocalOps(originalData, serverData);
                expect(serverOps).to.be.an('array').with.length(1);
                sortBy.restore();
                sort.restore();
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
                instance = new (getModel({
                    debug: true,
                    autoResolve: true,
                    JSONPatch: false,
                    optimistic: {debug: true}
                }))(originalData);
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
                delete serverData.shoes[0].style;
                serverData.car.model = 'De Ville';
                instance.car.set('model', 'Fleetwood');
                var serverDiff = instance._getDiff(originalData, serverData);
                var clientDiff = instance._getDiff(originalData, instance.toJSON());
                expect(serverDiff).to.be.an('array').with.length(3);
                expect(clientDiff).to.be.an('array').with.length(1);
                instance.on('sync:conflict', function (model, conflict) {
                    expect(conflict.resolved).to.be.an('array').with.length(2);
                    expect(conflict.resolved[1].server).to.eql({op: 'add', path: '/shoes/-', value: serverData.shoes[1]});
                    expect(conflict.conflicts).to.be.an('array').with.length(1);
                    expect(conflict.conflicts).to.include(
                        {
                            client: clientDiff[0],
                            server: _.findWhere(serverDiff, {path: '/car/model', op: 'replace'}),
                            original: originalData.car.model
                        },
                        {
                            server: _.findWhere(serverDiff, {path: '/shoes/0/style'}),
                            original: originalData.shoes[0].style
                        }
                    );
                    done();
                });
                instance._conflictDetector('foo-bar-baz', serverData);
            });

            it('applying collisionless changes and emitting sync:conflict-autoResolved when no conflicts remain', function (done) {
                var serverDiff = instance._getDiff(originalData, serverData);
                expect(serverDiff).to.be.an('array').with.length(1);
                instance.on('sync:conflict-autoResolved', function (model, conflict) {
                    expect(conflict).to.be.an('object');
                    expect(conflict.resolved).to.be.an('array').with.length(1);
                    expect(conflict.resolved[0].server).to.eql({op: 'add', path: '/shoes/-', value: serverData.shoes[1]});
                    expect(instance.shoes.toJSON()).to.eql(serverData.shoes);
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
                    expect(conflict).to.be.an('object');
                    expect(conflict.conflicts).to.not.exist;
                    done();
                });
                instance._conflictDetector('foo-bar-baz', serverData);
            });
        });
    });
    return lab;
};