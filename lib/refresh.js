'use strict';

var AWS  = require('aws-sdk');
var util = require('util');
var _    = require('lodash');
var fs   = require('fs');
var sem  = require('semaphore')(1);
var stringify = require("json-stringify-pretty-compact");

var processTemplate = require('../lib/process-template');

// Get the most recent AMI from Amazon
function getAMI(input_params, region = 'us-east-1') {
  AWS.config.update({region: region});
  var ec2 = new AWS.EC2({apiVersion: '2016-11-15'});

  var params = {
    Filters: [
      { Name: 'name', Values: [ input_params.Name ] },
      { Name: 'state', Values: [ 'available' ] }
    ],
    Owners: input_params.Owners
  };

  // Add optional parameters
  if (input_params.Platform) {
    params['Filters'] << { Name: 'platform', Values: [ input_params.Platform ] }
  }

  // Get the most recent AMI and return it in a Promise.
  return new Promise(function(fulfill, reject){
    // fulfill({ImageId: region, Id: input_params.Id});
    ec2.describeImages(params, function(err, data){
      if(err) reject(err);
      else {
        var image = _.orderBy(data.Images, ['CreationDate'], ['desc'])[0];
        image.Id = input_params.Id;
        fulfill(image);
      }
    });
  });
}


function updateAMIs(cwd, cb) {
  var globals_filename = util.format("%s/blueprints/common/globals.hbs", cwd);
  var GLOBALS = null;

  try {
    var GLOBALS = JSON.parse(processTemplate(fs.readFileSync(globals_filename)));
  } catch(err) {
    console.log("Can't find your 'globals.hbs' file.  Please create one and try again.\n%s", err);
    return;
  }

  // Process each region
  GLOBALS.Regions.forEach(function(region){
    var promises = [];

    GLOBALS.AMIs.forEach(function(ami){ promises.push(getAMI(ami, region.Id)); })

    Promise.all(promises)
    .then(function(values){
      // Gather the AMI information for this region
      var currentAMIs = {};
      values.forEach(function(value){currentAMIs[value.Id] = value.ImageId;})

  sem.take(function(){
      // Update the GLOBALS file with the AMI information
      fs.readFile(globals_filename, function(err, data){
        if (err) cb(err);
        else {
          // Replace the "AMIs" structure for this Region
          var json = JSON.parse(data);
          var regionIndex = _.findIndex(json.Regions, { Id: region.Id} )
          json.Regions[regionIndex].AMIs = currentAMIs;

          // Since there can be multiple Regions in the GLOBALS file, we need a semaphore to
          // prevent writing the file from another thread before we've finished updating it here
            console.log("writing %s...", region.Id);
            fs.writeFileSync(globals_filename, stringify(json, {maxLength:150}));
            sem.leave();
        }
      });
    });
  });
  });
}

module.exports = updateAMIs;