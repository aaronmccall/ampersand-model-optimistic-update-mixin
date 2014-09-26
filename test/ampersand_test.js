var Model = require('./helpers/ampersandTestModel');
var testGenerator = require('./helpers/testGenerator');

exports.lab = testGenerator(Model, {name: 'ampersand'});