/* jshint expr:true */
var _ = require('underscore');
var Lab = require('lab');
var sinon = require('sinon');
var mixin = require('../../');
var testData = require('./testData');
var expect = Lab.expect;

module.exports = function (BaseModel, config) {
    config = config || {};
    function getModel(_config) {
        return mixin(BaseModel, {
            _optimisticUpdate: _.extend({
                debug: config.debug
            }, _config)
        });
    }
    var lab = Lab.script();
    var describe = lab.experiment;
    var it = lab.test;
    var afterEach = lab.afterEach;
    var beforeEach = lab.beforeEach;
    describe(config.name + ': detects conflicts', function () {
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
            instance._applyDiff(instance._getDiff(originalData, clientData));
            expect(instance._ops).to.be.an('array');
            sinon.spy(instance, '_getDiff');
            instance._conflictDetector('foo-bar-baz', serverData);
            expect(instance._getDiff.callCount).to.equal(1);
            expect(instance._getDiff.firstCall.args).to.eql([originalData, serverData]);
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
                expect(conflict).to.be.an('object').and.have.keys('conflicts', 'serverState', 'resolved');
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
                expect(conflict).to.be.an('object').and.have.keys('conflicts', 'serverState', 'resolved');
                expect(conflict.conflicts).to.be.an('array').with.length(1);
                expect(_.findWhere(conflict.conflicts, {op: 'remove'})).to.not.exist;
                done();
            });
            instance._conflictDetector('foo-bar-baz', serverData);
        });

        it('discards changes to same value', function (done) {
            serverData.car.model = 'Fleetwood';
            instance.car.set('model', 'Fleetwood');
            expect(instance._ops).to.be.an('array').with.length(1);
            expect(_.omit(instance._ops[0], 'cid')).to.eql({op: 'replace', path: '/car/model', value: 'Fleetwood'});
            expect(instance._getDiff(originalData, serverData)).to.be.an('array').with.length(2);
            instance.on('sync:conflict', function (model, conflict) {
                expect(model).to.equal(instance);
                expect(conflict).to.be.an('object').and.have.keys('conflicts', 'serverState', 'resolved');
                expect(conflict.conflicts).to.be.an('array').with.length(1);
                expect(conflict.conflicts[0].server.op).to.not.equal('replace');
                done();
            });
            instance._conflictDetector('foo-bar-baz', serverData);
        });

        it('auto-resolves if autoResolve directive is true', function (done) {
            instance = new (getModel({debug: true, autoResolve: true, patcher: false, optimistic: {debug: true}}))(originalData);
            serverData.car.model = 'De Ville';
            instance.car.set('model', 'Fleetwood');
            var serverDiff = instance._getDiff(originalData, serverData);
            var clientDiff = instance._getDiff(originalData, instance.toJSON());
            expect(serverDiff).to.be.an('array').with.length(2);
            expect(clientDiff).to.be.an('array').with.length(1);
            instance.on('sync:conflict', function (model, conflict) {
                expect(conflict.resolved).to.be.an('array').with.length(1).and.include(
                    {op: 'add', path: '/shoes/-', value: serverData.shoes[1]}
                );
                expect(conflict.conflicts).to.be.an('array').with.length(1).and.include(
                    {
                        client: clientDiff[0],
                        server: _.findWhere(serverDiff, {op: 'replace'}),
                        original: originalData.car.model
                    }
                );
                expect(instance.shoes.toJSON()).to.eql(serverData.shoes);
                done();
            });
            instance._conflictDetector('foo-bar-baz', serverData);

        });

        it.skip('deep applies diffs to child models', function (done) {
            done();
        });

        it.skip('deep applies diffs to child collections', function (done) {
            done();
        });
    });
    return lab;
};