'use strict';

var async = require('async');
var fs = require('fs-extra');
var path = require('path');
var merge = require('../lib/merge');
var stringify = require("json-stringify-pretty-compact");

var processTemplate = require('../lib/process-template');

function helpfulJsonParse(string) {
  try {
    return JSON.parse(string);
  } catch (e) {
    console.error(string);
    throw 'Invalid JSON';
  }
}

function isTemplate(file) {
  return path.extname(file) === '.hbs';
}

function outputTemplateName(project, region) {
  if (project.EnvName) {
    return (project.ProjectName + '.' + project.EnvName + '.' + region.Id).toLowerCase() + '.template';
  } else {
    return (project.ProjectName + '.' + region.Id).toLowerCase() + '.template';
  }
}


// Create a 'Region' psuedo-attribute by extracting region information
// from a contexts 'Regions' and 'EnvRegion' attributes.
function regionizeContext(context, region) {
  // Create a new context and merge in the current context
  var master = {};
  merge(master, context);

  // Create the psuedo-attribute to hold region info
  master.Region = region;

  // Find the correct region infomrmation and try to merge it into the master
  try {
    var regionInfo = master.EnvRegions.filter(function(item){
      return item.Id === region.Id;
    })[0];
    merge(master.Region, regionInfo);
  } catch(err){
    // Eat this error
  }

  // Clean up the master
  delete master.Regions;
  delete master.EnvRegions;

  return master;
}

// Read a file from disk, extract the data, and process it against it's context
function readAndProcessTemplate(filename, context) {
  // We want to make sure the end-user can override pre-provided blueprints.  So we'll use
  // the 'global' version of the file unless there is a local version of that file.
  var filelocation = __dirname + '/../blueprints/' + filename;
  try {
    // Look for a local version of the file and use that instead
    fs.statSync(filename);
    filelocation = filename;
  } catch(err){
    // We didn't find a local version of the file
  }

  var data = fs.readFileSync(filelocation);
  var template = processTemplate(data, context);
  return template;
}

function build(cwd, template, cb) {
  try {
    var GLOBALS = JSON.parse(processTemplate(fs.readFileSync(cwd + '/blueprints/common/globals.hbs')));
  } catch(err) {
    console.log("Can't find your 'globals.hbs' file.  Please create one and try again.\n%s", err);
    return;
  }

  // Make sure the directory structure is properly configured for output
  fs.mkdirsSync(cwd + '/artifacts/cloudformation');
  process.chdir(cwd + '/blueprints');

  // Look for files to process
  fs.readdir('stacks', function(err, files) {
    if (err) {
      cb(err);
      return;
    }

    // Filter each file to make sure its a template and then process it in its own thread
    async.each(files.filter(isTemplate), function(filename, callback) {

      // Are we just processing a single template?
      if (template){
        var pathParts = path.parse(template);
        if(filename != pathParts.base && pathParts.dir.endsWith('stacks')) {
          callback();
          return;
        }
      }

      // Retrieve the ENVIRONMENT config for this template and build a Global context
      var pathArray = path.parse(filename).name.split('.');
      var projectName = pathArray[0];
      var env = pathArray[1];
      var ENVIRON = JSON.parse(processTemplate(fs.readFileSync(cwd + '/blueprints/common/'+env+'.hbs'), GLOBALS));
      var globalContext = merge(GLOBALS, ENVIRON);

      GLOBALS.Regions.forEach(function(region) {
        try {
          var projectContext = regionizeContext(globalContext, region);
          projectContext.ProjectName = projectName;
          var projectTemplate = readAndProcessTemplate('stacks/'+filename, projectContext);
          var project = helpfulJsonParse(projectTemplate);

          // Only process templates with no region specified or one that matches the current region
          if (project.Region && project.Region !== region.Id) {
            // console.log('Skipping %s:%s', region.Id, filename);
            return;
          }

          // Build the final template
          console.log('Processing %s:%s', region.Id, filename);
          var master = merge(project, projectContext);
          var template = readAndProcessTemplate(project.Template, master);

          // Make the template pretty and human readable, if the length isn't too long
          // console.log(template.length)
          var options = template.length > 40000 ? {maxLength: Infinity} : {maxLength: 120};
          var pretty = stringify(JSON.parse(template), options);

          fs.writeFileSync(cwd + '/artifacts/cloudformation/' + outputTemplateName(project, region), pretty);
        } catch(err) {
          console.log(template);
          console.log(err.stack);
          var msg = 'Error processing \'' + filename + '\' :' + err;
          cb(msg);
        }
      });
    });
    cb(null);
    return;
  });
}

module.exports = build;