var Finder = require('node-find-files')
var maven = require('maven')
var neo4j = require('neo4j-driver').v1
var Queue = require('kewkew')
var file = require('jsonfile')
var temp = require('tempfile')
var readline = require('readline')
var fs = require('fs')
var argv = require('minimist')(process.argv.slice(2));

var stateFile = '.graven-state'
var db = neo4j.driver("bolt://localhost", neo4j.auth.basic("neo4j", "password"))

var count = 0

// Collects all poms modified since last scan
function collect(state, poms) {
  var ts = new Date(state.timestamp)
  console.log('Scanning to collect new poms since '+ts)
  var rootFolder = argv.root || process.env['HOME']+'/.m2/repository/'
  var finder = new Finder({
    rootFolder : rootFolder,
    filterFunction : function (path, stat) {
        var file = path.substring(rootFolder.length)
        return (stat.mtime > ts) && // only new ones
        /\.pom$/.test(file) && // only poms
        (!argv.filter || new RegExp(argv.filter).test(file)) && // filtered
        (argv.snapshots || !(/-SNAPSHOT/.test(file)))// no snapshots
    }
  })
  finder.on('match', function(path, stat) {
    var modified = stat.mtime.getTime()
    poms.push({file:path.replace(/\\/g, '/').substring(rootFolder.length), root: rootFolder.replace(/\\/g, '/')})
    if(modified > state.timestamp) {
      state.timestamp = modified
    }
  })
  finder.on('complete', function() {
    console.log("Finished scan.")
    argv.s || file.writeFile(stateFile, state)
  })
  finder.startSearch()
}

// Resolves the dependency list for the given pom and queue it
function resolve(pom, done) {
  argv.v && console.log('Resolving dependencies for '+pom.file+'...' )
  var tokens = /(.*)\/(.*)\/(.*)\/(.*)/.exec(pom.file)
  var artifact = {
    groupId: tokens[1].replace(/\//g,'.'),
    artifactId: tokens[2],
    version: tokens[3]
  }
  var depFile = temp()
  maven.create({file: pom.root+pom.file, quiet:true})
  .execute('org.apache.maven.plugins:maven-dependency-plugin:2.8:list',
    { outputFile: depFile,
      excludeTransitive: true,
      'maven.wagon.http.ssl.insecure': true,
      'maven.wagon.http.ssl.allowall': true,
      excludeTypes: 'test-jar',
      excludeScopes: 'test'
    })
  .then(function() {
      var lineReader = readline.createInterface({
        input: fs.createReadStream(depFile)
      });
      lineReader.on('line', function(line) {
        var tokens = /^   (.*):(.*):(.*):(.*):(.*)/.exec(line)
        if(tokens) {
          var target = {
            groupId: tokens[1],
            artifactId: tokens[2],
            version: tokens[4]
          }
          deps.push({
            source: artifact,
            target: target,
            scope: tokens[5]
          })
        }
      })
      lineReader.on('close', function() {
        fs.unlink(depFile)
        done()
      })
  }, function(err) {
    console.log("Error", err)
    done(err)
  })
}

var merge =
  'MERGE (source:Artifact {artifactId:{source}.artifactId, groupId:{source}.groupId, version:{source}.version}) ' +
  'MERGE (target:Artifact {artifactId:{target}.artifactId, groupId:{target}.groupId, version:{target}.version}) ' +
  'MERGE (source)-[:DEPENDS_ON{scope: {scope}}]->(target)'
var session = db.session()

// Writes the dependency list in the graph database
function push(dep, done) {
  session
    .run(merge, dep)
    .catch(function(err) {
      console.error(err)
      done()
    })
    .then(function(result) {
      count++
      done()
    })
}

// Initialize the pom queue
var poms = new Queue(function(job, done) {
  resolve(job.data, done)
}, {concurrency: argv.p || 8, destroySuccessfulJobs: true})

// Initialize the dep list queue
var deps = new Queue(function(job, done) {
  push(job.data, done)
}, {concurrency: 1, destroySuccessfulJobs: true})

// Start collection of poms
if(!argv.noscan) {
  file.readFile(stateFile, function(err, state) {
    collect(state || { timestamp:0}, poms)
  })
}

// Show count of pushed items
var previous = 0;
setInterval(function() {
  if(count!=previous) {
    console.log('Pushed '+(count-previous)+' dependencies')
    previous = count
  }
}, 2000)
