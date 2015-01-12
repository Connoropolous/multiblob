
var tape = require('tape')

var util = require('../util')
var Blobs = require('../')

var pull   = require('pull-stream')
var crypto = require('crypto')
var rimraf = require('rimraf')
var path = require('path')
var osenv = require('osenv')

var dirname = path.join(osenv.tmpdir(), 'test-multiblob')
rimraf.sync(dirname)

var l = 100, random1 = []
while(l --) random1.push(crypto.randomBytes(1024))

function hasher (ary) {
  var hasher = util.createHash()
  pull(pull.values(ary), hasher, pull.drain())
  return hasher.digest
}

var hash1 = hasher(random1)

var blobs = Blobs(dirname)

tape('add, size', function (t) {

  pull(
    pull.values(random1),
    blobs.add(function (err, hash) {
      if(err) throw err
      t.equal(hash, hash1)
      blobs.size(hash, function (_, size) {
        t.equal(size, 100*1024)
        t.end()
      })
    })
  )
})

tape('errors if requested size too large', function (t) {
  pull(
    blobs.get({key: hash1, size: 1024*100 + 1}),
    pull.collect(function (err) {
      t.ok(err)
      t.end()
    })
  )
})

tape('errors if requested size too small', function (t) {
  pull(
    blobs.get({key: hash1, size: 1024*100 - 1}),
    pull.collect(function (err) {
      t.ok(err)
      t.end()
    })
  )
})

tape('does not error if size is correct', function (t) {
  pull(
    blobs.get({key: hash1, size: 1024*100}),
    pull.collect(function (err, arys) {
      if(err) throw err
      t.equal(hash1, hasher(arys))
      t.end()
    })
  )
})


tape('errors if requested max is under', function (t) {
  pull(
    blobs.get({key: hash1, max: 1024*100 - 1}),
    pull.collect(function (err) {
      t.ok(err)
      t.end()
    })
  )
})

tape('does not error if max is greater', function (t) {
  pull(
    blobs.get({key: hash1, max: 1024*100 + 1}),
    pull.collect(function (err, arys) {
      if(err) throw err
      t.equal(hash1, hasher(arys))
      t.end()
    })
  )
})

tape('does not error if max is equal', function (t) {
  pull(
    blobs.get({key: hash1, max: 1024*100}),
    pull.collect(function (err, arys) {
      if(err) throw err
      t.equal(hash1, hasher(arys))
      t.end()
    })
  )
})

