global.root = __dirname;

var env = require('node-env-file');
env(global.root + '/.env');

var _ = require('lodash');

var Error = require(global.root + '/lib/error.js');
var ArgValues = require(global.root + '/lib/argValues.js');
var AzureAuth = require(global.root + '/lib/azureAuth.js');
var PowerBi = require(global.root + '/lib/powerBi.js');

var azure = new AzureAuth();

new ArgValues(['dataset']).then(function(args) {
    azure.getToken().then(function(data) {
        var powerBi = new PowerBi(data.token);
        if(!_.isUndefined(args.reinit)) {
            powerBi.reInit(args.dataset).then(function(result) {
                console.log('APOA', result);
            }).catch(function(error) { Error.print('Something went wrong', error); });
        } else {
            powerBi.init(args.dataset).then(function(result) {
                console.log(result.message);
            }).catch(function(error) { Error.print('Something went wrong', error); });
        }
    }).catch(function(error) { Error.print('Something went wrong', error); });
}).catch(function(error) { Error.print('Something went wrong', error); });