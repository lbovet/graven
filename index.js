var Finder = require('node-find-files')
var maven = require('maven')
var neo4j = require('neo4j-driver')
var Queue = require('kewkew')
var file = require('jsonfile')
var temp = require('tempfile')
var readline = require('readline')

var stateFile = '.graven-state'

// Collects all poms modified since last scan
function collect(state, poms) {
  var pattern = /.pom$/
  var ts = new Date(state.timestamp)
  console.log('Collecting new poms since '+ts)
  var finder = new Finder({
    rootFolder : process.env['HOME']+'/.m2/repository',
    filterFunction : function (path, stat) {
        return (stat.mtime > ts) && pattern.test(path)
    }
  })
  finder.on('match', function(path, stat) {
    var modified = stat.mtime.getTime()
    poms.push({file:path})
    if(modified > state.timestamp) {
      state.timestamp = modified
      file.writeFile(stateFile, state)
    }
  })
  finder.startSearch()
}

// Resolves the dependency list for the given pom and queue it
function resolve(pom, done) {
  console.log('Resolving dependencies for '+pom.file)
  maven.create({file: pom.file}).execute('dependency:list')
  done()
}

// Writes the dependency list in the graph database
function push(depList, done) {
  done()
}

// Initialize the pom queue
var poms = new Queue(function(job, done) {
  resolve(job.data, done)
}, {concurrency: 1, destroySuccessfulJobs: true})

// Initialize the dep list queue
var depLists = new Queue(function(job, done) {
  push(job.data, done)
}, {destroySuccessfulJobs: true})

// Start collection of poms
file.readFile(stateFile, function(err, state) {
  collect(state || { timestamp:0}, poms)
})

var p = '/home/shaman/.m2/repository/li/chee/bugtik/bugtik/0.1.0/bugtik-0.1.0.pom'

function mvn(p, cb) {

  console.log('Starting mvn '+p)
  var depFile = temp()
  maven
  .create({file: p, quiet:true})
  .execute('dependency:list', { outputFile: depFile })
  .then(function() {
      var lineReader = readline.createInterface({
        input: require('fs').createReadStream(depFile)
      });
      lineReader.on('line', function (line) {
        console.log('Line from file:', line);
      });
  },function(err) {
    console.log("Error", err)
  })
}

mvn(p, function(arg) {
  console.log(arg)
})
