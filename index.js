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

// Collects all poms modified since last scan
function collect(state, poms) {
  var ts = new Date(state.timestamp)
  console.log('Scanning to collect new poms since '+ts)
  var rootFolder = argv.root || process.env['HOME']+'/.m2/repository/'
  var finder = new Finder({
    rootFolder : rootFolder,
    filterFunction : function (path, stat) {
        return (stat.mtime > ts) && // only new ones
        /\.pom$/.test(path) && // only poms
        (!argv.filter || new RegExp(argv.filter).test(path.substring(rootFolder.length))) && // filtered
        (argv.snapshots || !(/-SNAPSHOT/.test(path)))// no snapshots
    }
  })
  finder.on('match', function(path, stat) {
    var modified = stat.mtime.getTime()
    poms.push({file:path.replace(/\\/g, '/'), root: rootFolder.replace(/\\/g, '/')})
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
  argv.v && console.log('Resolving dependencies for '+pom.file+' / '+pom.root)
  var tokens = /(.*)\/(.*)\/(.*)\/(.*)/.exec(pom.file.substring(pom.root.length))
  var artifact = {
    groupId: tokens[1].replace(/\//g,'.'),
    artifactId: tokens[2],
    version: tokens[3]
  }
  var depFile = temp()
  maven.create({file: p, quiet:true})
  .execute('org.apache.maven.plugins:maven-dependency-plugin:2.8:list', { outputFile: depFile, excludeTransitive: true })
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
            from: artifact,
            to: target,
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

// Writes the dependency list in the graph database
function push(dep, done) {
  var session = db.session();
  session
    .run( "MERGE (a:Artifact {a})", {a: dep.from} )
    .then( function( result ) {
      console.log( result.records[0].get("title") + " " + result.records[0].get("name") );
      session.close();
      done()
    })
}

// Initialize the pom queue
var poms = new Queue(function(job, done) {
  resolve(job.data, done)
}, {concurrency: 4, destroySuccessfulJobs: true})

// Initialize the dep list queue
var deps = new Queue(function(job, done) {
  push(job.data, done)
}, {destroySuccessfulJobs: true})

// Start collection of poms
file.readFile(stateFile, function(err, state) {
  //collect(state || { timestamp:0}, poms)
})

push({ from:
   { groupId: 'li.chee.bugtik',
     artifactId: 'bugtik',
     version: '1.0.0' },
  to:
   { groupId: 'org.springframework.boot',
     artifactId: 'spring-boot-starter-data-jpa',
     version: '1.2.6.RELEASE' },
  scope: 'compile' }, function() {})
