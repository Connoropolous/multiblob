var cont     = require('cont')
var pull     = require('pull-stream')
var defer    = require('pull-defer')
var path     = require('path')
var explain  = require('explain-error')
var mkdirp   = require('mkdirp')
var rimraf   = require('rimraf')
var fs       = require('fs')
var glob     = require('pull-glob')
var paramap  = require('pull-paramap')
var cat      = require('pull-cat')
var Notify   = require('pull-notify')

var Write    = require('pull-write-file')
var Read     = require('pull-file')

var u = require('./util')
var createHash = u.createHash

function write (filename, cb) {
  return WriteFile(filename, cb)
}

function read (filename) {
  return ReadFile(filename)
}

function toArray (h) {
  return Array.isArray(h) ? h : [h]
}

function single (fn) {
  var waiting = {}
  function async (key, cb) {
    if(!waiting[key]) {
      waiting[key] = [cb]
      var cbs = waiting[key]
      fn(key, function done (err, result) {
        if(cbs.length)
        delete waiting[key]
        while(cbs.length) cbs.shift()(err, result)
      })
    }
    else
      waiting[key].push(cb)
  }

  //dump all the things that have been done already,
  //when something has been added?
  async.done = function (key, err, value) {
    if(!waiting[key]) return
    var cbs = waiting[key]
    delete waiting[key]
    while(cbs.length) cbs.shift()(err, result)
  }

  return async
}

var Blobs = module.exports = function (config) {
  var dir
  if('string' === typeof config)
    dir = config, config = {dir: dir}

  var encode = config.encode || u.encode
  var decode = config.decode || u.decode
  var isHash = config.isHash || u.isHash

  function toPath (dir, string) {
    var d = decode(string)
    var h = d.hash.toString('hex')
    return path.join(dir, d.alg, h.substring(0,2), h.substring(2))
  }

  function toHash(filename) {
    var parts = path.relative(dir, filename).split(path.sep)
    var alg = parts.shift()
    return encode(new Buffer(parts.join(''), 'hex'), alg)
  }

  var newBlob = Notify()

  config = config || {}
  var alg = config.hash = config.hash || config.alg || 'blake2s'

  dir = config.dir

  var n = 0
  var waiting = [], tmp = false, clean = false

  function init (cb) {
    if(tmp) return cb()
    else waiting.push(cb)
  }

  var stat = single(fs.stat)

  var tmpdir = path.join(dir, 'tmp')

  rimraf(tmpdir, function () {
    mkdirp(tmpdir, function () {
      tmp = true; while(waiting.length) waiting.shift()()
    })
  })

  function toMeta(hash, stat) {
    if(!stat) return null
    return {id: hash, size: stat.size, ts: +stat.ctime}
  }

  function has (hash) {
    return function (cb) {
      stat(toPath(dir, hash), function (err, stat) {
        cb(null, !!stat)
      })
    }
  }

  function size (hash) {
    return function (cb) {
      stat(toPath(dir, hash), function (err, stat) {
        cb(null, stat ? stat.size : null)
      })
    }
  }

  var meta = function (hash, cb) {
    stat(toPath(dir, hash), function (err, stat) {
      cb(err, toMeta(hash, stat))
    })
  }

  function createTester (test) {
    return function (hashes, cb) {
      var n = !Array.isArray(hashes)
      cont.para(toArray(hashes).map(test)) (function (_, ary) {
        // This will only error if the hash is not present,
        // so never callback an error.
        // PS. if you have a situation where you never error
        // add a comment like this one to explain why.
        if(n) cb(null, ary[0])
        else  cb(null, ary)
      })
      return cb
    }
  }

  var listeners = []

  return {
    get: function (opts) {
      if(isHash(opts))
        return Read(toPath(dir, opts))

      var hash = opts.key || opts.hash
      if(!isHash(hash))
        return pull.error(new Error(
          'multiblob.get: {hash} is mandatory'
        ))

      var stream = defer.source()
      stat(toPath(dir, hash), function (err, stat) {
        if(opts.size != null && opts.size !== stat.size)
          stream.abort(new Error('incorrect file length,'
            + ' requested:' + opts.size + ' file was:' + stat.size
            + ' for file:' + hash
          ))

        else if(opts.max != null && opts.max < stat.size)
          stream.abort(new Error('incorrect file length,'
            + ' requested:' + opts.size + ' file was:' + stat.size
            + ' for file:' + hash
          ))

        else
          stream.resolve(Read(toPath(dir, hash)))
      })

      return stream
    },

    size: createTester(size),

    has: createTester(has),
    meta: meta,

    add: function (hash, cb) {
      if('function' === typeof hash) cb = hash, hash = null

      if(!cb) cb = function (err) {
        if(err) throw explain(err, 'no callback provided')
      }

      var deferred = defer.sink()
      init(function () {
        var tmpfile = path.join(dir, 'tmp', Date.now() + '-' + n++)
        var hasher = createHash(alg, true)
        var size = 0

        deferred.resolve(pull(
          hasher,
          pull.map(function (data) {
            if('string' === typeof data) data = new Buffer(data, 'utf8')
            size += data.length
            return data
          }),
          Write(tmpfile, function (err) {
            if(err) return cb(explain(err, 'could not write to tmpfile'))

            var _hash = encode(hasher.digest, alg)

            if(hash && hash !== _hash)
              return cb(new Error('actual hash:'+ _hash
                + ' did not match expected hash:'+hash), _hash)

            var p = toPath(dir, hash || _hash)

            mkdirp(path.dirname(p), function () {
              fs.rename(tmpfile, p, function (err) {
                if(err) cb(explain(err, 'could not move file'))
                else    newBlob({id:toHash(p), size: size, ts: Date.now()}), cb(null, _hash)
              })
            })
          })
        ))
      })

      return deferred
    },
    ls: function (opts) {
      opts = opts || {}
      var isOld = opts.old !== false
      var isLive = opts.live === true || opts.old === false

      if(!isLive && !isOld)
        throw new Error('ls with neither old or new is empty')

      var long = (opts.size || opts.long || opts.meta)
      var old = pull(
        glob(path.join(dir, '*', '*', '*')),
        long ? paramap(function (filename, cb) {
          stat(filename, function (err, stat) {
            cb(err, toMeta(toHash(filename), stat))
          })
        }, 32) : pull.map(toHash)
      )

      if(!isLive) return old

      var live = long
          ? newBlob.listen()
          : pull(newBlob.listen(), pull.map(function (e) { return e.id }))

      if(!isOld) return live

      //old & live
      return cat([old, pull.once({sync: true}), live])
    },
    rm: function (hash, cb) {
      fs.unlink(toPath(dir, hash), cb)
    },
    resolve: function (hash) {
      return toPath(dir, hash)
    }
  }
}


