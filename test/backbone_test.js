var Model = require('./helpers/backboneTestModel');
var testGenerator = require('./helpers/testGenerator');

exports.lab = testGenerator(Model, {name: 'backbone'});