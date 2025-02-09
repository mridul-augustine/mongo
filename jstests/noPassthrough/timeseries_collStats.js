/**
 * Tests that running collStats against a time-series collection includes statistics specific to
 * time-series collections.
 *
 * @tags: [
 *   does_not_support_stepdowns,
 *   requires_getmore,
 * ]
 */
(function() {
"use strict";

load("jstests/core/timeseries/libs/timeseries.js");

const conn = MongoRunner.runMongod();

const dbName = jsTestName();
const testDB = conn.getDB(dbName);
const isTimeseriesBucketCompressionEnabled =
    TimeseriesTest.timeseriesBucketCompressionEnabled(testDB);

assert.commandWorked(testDB.dropDatabase());

const coll = testDB.getCollection('t');
const bucketsColl = testDB.getCollection('system.buckets.' + coll.getName());

const timeFieldName = 'time';
const metaFieldName = 'meta';

const expectedStats = {
    bucketsNs: bucketsColl.getFullName()
};

const clearCollection = function() {
    coll.drop();
    assert.commandWorked(testDB.createCollection(
        coll.getName(), {timeseries: {timeField: timeFieldName, metaField: metaFieldName}}));
    assert.contains(bucketsColl.getName(), testDB.getCollectionNames());

    expectedStats.bucketCount = 0;
    expectedStats.numBucketInserts = 0;
    expectedStats.numBucketUpdates = 0;
    expectedStats.numBucketsOpenedDueToMetadata = 0;
    expectedStats.numBucketsClosedDueToCount = 0;
    expectedStats.numBucketsClosedDueToSize = 0;
    expectedStats.numBucketsClosedDueToTimeForward = 0;
    expectedStats.numBucketsClosedDueToTimeBackward = 0;
    expectedStats.numBucketsClosedDueToMemoryThreshold = 0;
    expectedStats.numCommits = 0;
    expectedStats.numWaits = 0;
    expectedStats.numMeasurementsCommitted = 0;
    expectedStats.numCompressedBuckets = 0;
    expectedStats.numUncompressedBuckets = 0;
};
clearCollection();

const checkCollStats = function(empty = false) {
    const stats = assert.commandWorked(coll.stats());

    assert.eq(coll.getFullName(), stats.ns);

    for (let [stat, value] of Object.entries(expectedStats)) {
        assert.eq(stats.timeseries[stat],
                  value,
                  "Invalid 'timeseries." + stat + "' value in collStats: " + tojson(stats));
    }

    if (empty) {
        assert(!stats.timeseries.hasOwnProperty('avgBucketSize'));
        assert(!stats.timeseries.hasOwnProperty('avgNumMeasurementsPerCommit'));
    } else {
        assert.gt(stats.timeseries.avgBucketSize, 0);
    }

    assert(!stats.timeseries.hasOwnProperty('count'));
    assert(!stats.timeseries.hasOwnProperty('avgObjSize'));

    if (expectedStats.numCompressedBuckets > 0) {
        assert.lt(stats.timeseries["numBytesCompressed"],
                  stats.timeseries["numBytesUncompressed"],
                  "Invalid 'timeseries.numBytesCompressed' value in collStats: " + tojson(stats));
    }
};

checkCollStats(true);

let docs = Array(3).fill({[timeFieldName]: ISODate(), [metaFieldName]: {a: 1}});
assert.commandWorked(coll.insert(docs, {ordered: false}));
expectedStats.bucketCount++;
expectedStats.numBucketInserts++;
expectedStats.numBucketsOpenedDueToMetadata++;
expectedStats.numCommits++;
expectedStats.numMeasurementsCommitted += 3;
expectedStats.avgNumMeasurementsPerCommit = 3;
checkCollStats();

assert.commandWorked(
    coll.insert({[timeFieldName]: ISODate(), [metaFieldName]: {a: 2}}, {ordered: false}));
expectedStats.bucketCount++;
expectedStats.numBucketInserts++;
expectedStats.numBucketsOpenedDueToMetadata++;
expectedStats.numCommits++;
expectedStats.numMeasurementsCommitted++;
expectedStats.avgNumMeasurementsPerCommit = 2;
checkCollStats();

assert.commandWorked(
    coll.insert({[timeFieldName]: ISODate(), [metaFieldName]: {a: 2}}, {ordered: false}));
expectedStats.numBucketUpdates++;
expectedStats.numCommits++;
expectedStats.numMeasurementsCommitted++;
expectedStats.avgNumMeasurementsPerCommit = 1;
checkCollStats();

docs = Array(5).fill({[timeFieldName]: ISODate(), [metaFieldName]: {a: 2}});
assert.commandWorked(coll.insert(docs, {ordered: false}));
expectedStats.numBucketUpdates++;
expectedStats.numCommits++;
expectedStats.numMeasurementsCommitted += 5;
expectedStats.avgNumMeasurementsPerCommit = 2;
checkCollStats();

assert.commandWorked(coll.insert(
    {[timeFieldName]: ISODate("2021-01-01T01:00:00Z"), [metaFieldName]: {a: 1}}, {ordered: false}));
expectedStats.bucketCount++;
expectedStats.numBucketInserts++;
expectedStats.numCommits++;
expectedStats.numBucketsClosedDueToTimeBackward++;
expectedStats.numMeasurementsCommitted++;
if (isTimeseriesBucketCompressionEnabled) {
    expectedStats.numCompressedBuckets++;
}
checkCollStats();

// Assumes each bucket has a limit of 1000 measurements.
const bucketMaxCount = 1000;
let numDocs = bucketMaxCount + 100;
docs = Array(numDocs).fill({[timeFieldName]: ISODate(), [metaFieldName]: {a: 'limit_count'}});
assert.commandWorked(coll.insert(docs, {ordered: false}));
expectedStats.bucketCount += 2;
expectedStats.numBucketInserts += 2;
expectedStats.numBucketsOpenedDueToMetadata++;
expectedStats.numBucketsClosedDueToCount++;
expectedStats.numCommits += 2;
expectedStats.numMeasurementsCommitted += numDocs;
expectedStats.avgNumMeasurementsPerCommit =
    Math.floor(expectedStats.numMeasurementsCommitted / expectedStats.numCommits);
if (isTimeseriesBucketCompressionEnabled) {
    expectedStats.numCompressedBuckets++;
}
checkCollStats();

// Assumes each bucket has a limit of 125kB on the measurements stored in the 'data' field.
const bucketMaxSizeKB = 125;
numDocs = 2;
// The measurement data should not take up all of the 'bucketMaxSizeKB' limit because we need
// to leave a little room for the _id and the time fields.
// This test leaves the bucket with a single measurement which will cause compression to be
// by-passed. The stats tracking of compressed buckets will thus also be by-passed.
let largeValue = 'x'.repeat((bucketMaxSizeKB - 1) * 1024);
docs = Array(numDocs).fill(
    {[timeFieldName]: ISODate(), x: largeValue, [metaFieldName]: {a: 'limit_size'}});
assert.commandWorked(coll.insert(docs, {ordered: false}));
expectedStats.bucketCount += numDocs;
expectedStats.numBucketInserts += numDocs;
expectedStats.numBucketsOpenedDueToMetadata++;
expectedStats.numBucketsClosedDueToSize++;
expectedStats.numCommits += numDocs;
expectedStats.numMeasurementsCommitted += numDocs;
expectedStats.avgNumMeasurementsPerCommit =
    Math.floor(expectedStats.numMeasurementsCommitted / expectedStats.numCommits);
checkCollStats();

// Assumes the measurements in each bucket span at most one hour (based on the time field).
// This test leaves just one measurement per bucket which will cause compression to be
// by-passed. The stats tracking of compressed buckets will thus also be by-passed.
const docTimes = [ISODate("2020-11-13T01:00:00Z"), ISODate("2020-11-13T03:00:00Z")];
numDocs = 2;
docs = [];
for (let i = 0; i < numDocs; i++) {
    docs.push({[timeFieldName]: docTimes[i], [metaFieldName]: {a: 'limit_time_range'}});
}
assert.commandWorked(coll.insert(docs, {ordered: false}));
expectedStats.bucketCount += numDocs;
expectedStats.numBucketInserts += numDocs;
expectedStats.numBucketsOpenedDueToMetadata++;
expectedStats.numBucketsClosedDueToTimeForward++;
expectedStats.numCommits += numDocs;
expectedStats.numMeasurementsCommitted += numDocs;
expectedStats.avgNumMeasurementsPerCommit =
    Math.floor(expectedStats.numMeasurementsCommitted / expectedStats.numCommits);
checkCollStats();

const kIdleBucketExpiryMemoryUsageThreshold = 1024 * 1024 * 100;
numDocs = 70;
largeValue = 'a'.repeat(1024 * 1024);

const testIdleBucketExpiry = function(docFn) {
    clearCollection();

    let shouldExpire = false;
    for (let i = 0; i < numDocs; i++) {
        assert.commandWorked(coll.insert(docFn(i), {ordered: false}));
        const memoryUsage = assert.commandWorked(testDB.serverStatus()).bucketCatalog.memoryUsage;

        expectedStats.bucketCount++;
        expectedStats.numBucketInserts++;
        expectedStats.numBucketsOpenedDueToMetadata++;
        if (shouldExpire) {
            expectedStats.numBucketsClosedDueToMemoryThreshold++;
        }
        expectedStats.numCommits++;
        expectedStats.numMeasurementsCommitted++;
        expectedStats.avgNumMeasurementsPerCommit =
            Math.floor(expectedStats.numMeasurementsCommitted / expectedStats.numCommits);
        checkCollStats();

        shouldExpire = memoryUsage > kIdleBucketExpiryMemoryUsageThreshold;
    }

    assert(shouldExpire, 'Memory usage did not reach idle bucket expiry threshold');
};

testIdleBucketExpiry(i => {
    return {[timeFieldName]: ISODate(), [metaFieldName]: {[i.toString()]: largeValue}};
});
testIdleBucketExpiry(i => {
    return {[timeFieldName]: ISODate(), [metaFieldName]: i, a: largeValue};
});

MongoRunner.stopMongod(conn);
})();
