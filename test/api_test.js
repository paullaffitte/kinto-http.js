"use strict";

import chai, { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import sinon from "sinon";
import { EventEmitter } from "events";
import { quote } from "../src/utils";
import { fakeServerResponse } from "./test_utils.js";
import KintoClient, { SUPPORTED_PROTOCOL_VERSION as SPV } from "../src";
import * as requests from "../src/requests";

chai.use(chaiAsPromised);
chai.should();
chai.config.includeStack = true;

const root = typeof window === "object" ? window : global;
const FAKE_SERVER_URL = "http://fake-server/v1";

/** @test {KintoClient} */
describe("KintoClient", () => {
  let sandbox, api, events;

  beforeEach(() => {
    sandbox = sinon.sandbox.create();
    events = new EventEmitter();
    api = new KintoClient(FAKE_SERVER_URL, {events});
  });

  afterEach(() => {
    sandbox.restore();
  });

  /** @test {KintoClient#constructor} */
  describe("#constructor", () => {
    const sampleRemote = `http://test/${SPV}`;

    it("should check that `remote` is a string", () => {
      expect(() => new KintoClient(42, {events}))
        .to.Throw(Error, /Invalid remote URL/);
    });

    it("should validate `remote` arg value", () => {
      expect(() => new KintoClient("http://nope"))
        .to.Throw(Error, /The remote URL must contain the version/);
    });

    it("should strip any trailing slash", () => {
      expect(new KintoClient(sampleRemote).remote).eql(sampleRemote);
    });

    it("should expose a passed events instance option", () => {
      expect(new KintoClient(sampleRemote, {events}).events).to.eql(events);
    });

    it("should propagate its events property to child dependencies", () => {
      const api = new KintoClient(sampleRemote, {events});
      expect(api.http.events).eql(api.events);
    });

    it("should assign version value", () => {
      expect(new KintoClient(sampleRemote).version).eql(SPV);
      expect(new KintoClient(sampleRemote).version).eql(SPV);
    });

    it("should accept a headers option", () => {
      expect(new KintoClient(sampleRemote, {headers: {Foo: "Bar"}}).optionHeaders)
        .eql({Foo: "Bar"});
    });

    it("should validate protocol version", () => {
      expect(() => new KintoClient(`http://test/v999`))
        .to.Throw(Error, /^Unsupported protocol version/);
    });

    it("should propagate the requestMode option to the child HTTP instance", () => {
      const requestMode = "no-cors";
      expect(new KintoClient(sampleRemote, {requestMode}).http.requestMode)
        .eql(requestMode);
    });

    it("should create an event emitter if none is provided", () => {
      expect(new KintoClient(sampleRemote).events)
        .to.be.an.instanceOf(EventEmitter);
    });

    it("should expose provided event emitter as a property", () => {
      const events = new EventEmitter();
      expect(new KintoClient(sampleRemote, {events}).events).eql(events);
    });

    it("should accept a bucket option", () => {
      const api = new KintoClient(sampleRemote, {bucket: "custom"});
      expect(api.defaultBucket).eql("custom");
    });

    it("should accept a safe option", () => {
      const api = new KintoClient(sampleRemote, {safe: true});
      expect(api.defaultSafe).eql(true);
    });
  });

  /** @test {KintoClient#backoff} */
  describe("get backoff()", () => {
    it("should provide the remaining backoff time in ms if any", () => {
      // Make Date#getTime always returning 1000000, for predictability
      sandbox.stub(Date.prototype, "getTime").returns(1000 * 1000);
      sandbox.stub(root, "fetch").returns(
        fakeServerResponse(200, {}, {Backoff: "1000"}));

      return api.fetchChangesSince()
        .then(_ => expect(api.backoff).eql(1000000));
    });

    it("should provide no remaining backoff time when none is set", () => {
      sandbox.stub(root, "fetch").returns(fakeServerResponse(200, {}, {}));

      return api.fetchChangesSince()
        .then(_ => expect(api.backoff).eql(0));
    });
  });

  /** @test {KintoClient#fetchServerSettings} */
  describe("#fetchServerSettings", () => {
    it("should retrieve server settings on first request made", () => {
      sandbox.stub(root, "fetch").returns(fakeServerResponse(200, {
        settings: {"cliquet.batch_max_requests": 25}
      }));

      return api.fetchServerSettings()
        .should.eventually.become({"cliquet.batch_max_requests": 25});
    });

    it("should store server settings into the serverSettings property", () => {
      api.serverSettings = {a: 1};
      sandbox.stub(root, "fetch");

      api.fetchServerSettings();
    });

    it("should not fetch server settings if they're cached already", () => {
      api.serverSettings = {a: 1};
      sandbox.stub(root, "fetch");

      api.fetchServerSettings();
      sinon.assert.notCalled(fetch);
    });
  });

  /** @test {KintoClient#fetchChangesSince} */
  describe("#fetchChangesSince", () => {
    it("should fetch server settings", () => {
      sandbox.stub(api, "fetchServerSettings")
        .returns(Promise.resolve({foo: 42}));

      api.fetchChangesSince("blog", "articles");

      sinon.assert.calledOnce(api.fetchServerSettings);
    });

    describe("Request", () => {
      beforeEach(() => {
        sandbox.stub(root, "fetch")
          // fetch server Settings
          .onFirstCall().returns(fakeServerResponse(200, {}, {}))
          // fetch latest changes
          .onSecondCall().returns(fakeServerResponse(200, {data: []}, {}));
      });

      it("should merge instance option headers", () => {
        api.optionHeaders = {Foo: "Bar"};
        return api.fetchChangesSince("blog", "articles", {lastModified: 42})
          .then(_ => expect(fetch.secondCall.args[1].headers.Foo).eql("Bar"));
      });

      it("should request server changes since last modified", () =>{
        return api.fetchChangesSince("blog", "articles", {lastModified: 42})
          .then(_ => expect(fetch.secondCall.args[0]).to.match(/\?_since=42/));
      });

      it("should attach an If-None-Match header if lastModified is provided", () =>{
        return api.fetchChangesSince("blog", "articles", {lastModified: 42})
          .then(_ => expect(fetch.secondCall.args[1].headers["If-None-Match"]).eql(quote(42)));
      });

      it("should merge provided headers with default ones", () => {
        const options = {lastModified: 42, headers: {Foo: "bar"}};
        return api.fetchChangesSince("blog", "articles", options)
          .then(_ => expect(fetch.secondCall.args[1].headers).eql({
            "Foo": "bar",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "If-None-Match": quote(42),
          }));
      });
    });

    describe("Response", () => {
      it("should resolve with a result object", () => {
        sandbox.stub(root, "fetch").returns(
          fakeServerResponse(200, {data: []}, {"ETag": quote(41)}));

        return api.fetchChangesSince("blog", "articles", { lastModified: 42 })
          .should.eventually.become({
            lastModified: 41,
            changes: []
          });
      });

      it("should resolve with no changes if HTTP 304 is received", () => {
        sandbox.stub(root, "fetch").returns(fakeServerResponse(304, {}));

        return api.fetchChangesSince("blog", "articles", {lastModified: 42})
          .should.eventually.become({lastModified: 42, changes: []});
      });

      it("should reject on any HTTP status >= 400", () => {
        sandbox.stub(root, "fetch").returns(fakeServerResponse(401, {}));

        return api.fetchChangesSince("blog", "articles")
          .should.eventually.be.rejectedWith(Error, /HTTP 401/);
      });

      it("should reject with detailed error message", () => {
        sandbox.stub(root, "fetch").returns(fakeServerResponse(401, {
          errno: 105
        }));

        return api.fetchChangesSince("blog", "articles")
          .should.eventually.be.rejectedWith(Error, /HTTP 401; Invalid Authorization Token/);
      });

      it("should expose json response body to err object on rejection", () => {
        const response = {errno: 105, message: "Dude."};

        sandbox.stub(root, "fetch").returns(fakeServerResponse(401, response));

        return api.fetchChangesSince("blog", "articles")
          .catch(err => err.data)
          .should.eventually.become(response);
      });

      it("should reject on server flushed", () => {
        sandbox.stub(root, "fetch").returns(
          fakeServerResponse(200, {data: []}, {ETag: quote(43)}));

        return api.fetchChangesSince("blog", "articles", {lastModified: 42})
          .should.be.rejectedWith(Error, /Server has been flushed/);
      });
    });
  });

  /** @test {KintoClient#batch} */
  describe("#batch", () => {
    beforeEach(() => {
      sandbox.stub(api, "fetchServerSettings").returns(Promise.resolve({
        "batch_max_requests": 3
      }));
    });

    function executeBatch(fixtures, options) {
      return api.batch(batch => {
        for (const article of fixtures) {
          batch.createRecord("blog", article);
        }
      }, options);
    }

    describe("server request", () => {
      let requestBody, requestHeaders;

      beforeEach(() => {
        sandbox.stub(root, "fetch").returns(fakeServerResponse(200, {
          responses: []
        }));
      });

      it("should ensure server settings are fetched", () => {
        return api.batch(batch => batch.createCollection())
          .then(_ => sinon.assert.calledOnce(api.fetchServerSettings));
      });

      describe("empty request list", () => {
        it("should not perform request on empty operation list", () => {
          api.batch(batch => {});

          sinon.assert.notCalled(fetch);
        });
      });

      describe("non-empty request list", () => {
        const fixtures = [
          {title: "art1"},
          {title: "art2"},
          {title: "art3"},
        ];

        beforeEach(() => {
          api.optionHeaders = {Authorization: "Basic plop"};
          return api.batch(batch => {
            for (const article of fixtures) {
              batch.createRecord("blog", article);
            }
          }, {headers: {Foo: "Bar"}})
            .then(_ => {
              const request = fetch.firstCall.args[1];
              requestHeaders = request.headers;
              requestBody = JSON.parse(request.body);
            });
        });

        it("should call the batch endpoint", () => {
          sinon.assert.calledWithMatch(fetch, `/${SPV}/batch`);
        });

        it("should define main batch request default headers", () => {
          expect(requestBody.defaults.headers).eql({
            "Authorization": "Basic plop",
            "Foo": "Bar",
          });
        });

        it("should attach all batch request headers", () => {
          expect(requestHeaders.Authorization).eql("Basic plop");
        });

        it("should batch the expected number of requests", () => {
          expect(requestBody.requests.length).eql(3);
        });
      });

      describe("Safe mode", () => {
        const fixtures = [
          {title: "art1"},
          {title: "art2", last_modified: 42},
        ];

        it("should forward the safe option to resulting requests", () => {
          return api.batch(batch => {
            for (const article of fixtures) {
              batch.createRecord("blog", article);
            }
          }, {safe: true})
            .then(_ => {
              const {requests} = JSON.parse(fetch.firstCall.args[1].body);
              expect(requests.map(r => r.headers))
                .eql([
                  {"If-None-Match": "*"},
                  {"If-Match": quote(42)},
                ]);
            });
        });
      });
    });

    describe("server response", () => {
      const fixtures = [
        { id: 1, title: "art1" },
        { id: 2, title: "art2" },
      ];

      it("should reject on HTTP 400", () => {
        sandbox.stub(root, "fetch").returns(fakeServerResponse(400, {
          error: true,
          errno: 117,
          message: "http 400"
        }));

        return executeBatch(fixtures)
          .should.eventually.be.rejectedWith(Error, /HTTP 400/);
      });

      it("should reject on HTTP error status code", () => {
        sandbox.stub(root, "fetch").returns(fakeServerResponse(500, {
          error: true,
          message: "http 500"
        }));

        return executeBatch(fixtures)
          .should.eventually.be.rejectedWith(Error, /HTTP 500/);
      });

      it("should expose succesful subrequest responses", () => {
        const responses = [
          { status: 201,
            path: `/${SPV}/buckets/blog/collections/articles/records`,
            body: { data: fixtures[0]}},
          { status: 201,
            path: `/${SPV}/buckets/blog/collections/articles/records`,
            body: { data: fixtures[1]}},
        ];
        sandbox.stub(root, "fetch")
          .returns(fakeServerResponse(200, {responses}));

        return executeBatch(fixtures)
          .should.eventually.become(responses);
      });

      it("should expose failing subrequest responses", () => {
        const missingRemotely = fixtures[0];
        const responses = [
          {
            status: 404,
            path: `/${SPV}/buckets/blog/collections/articles/records/1`,
            body: missingRemotely
          },
        ];
        sandbox.stub(root, "fetch")
          .returns(fakeServerResponse(200, {responses}));

        return executeBatch(fixtures)
          .should.eventually.become(responses);
      });

      it("should resolve with encountered HTTP 500", () => {
        const responses =  [
          {
            status: 500,
            path: `/${SPV}/buckets/blog/collections/articles/records/1`,
            body: { 500: true }
          },
        ];
        sandbox.stub(root, "fetch")
          .returns(fakeServerResponse(200, {responses}));

        return executeBatch(fixtures)
          .should.eventually.become(responses);
      });

      it("should expose encountered HTTP 412", () => {
        const responses = [
          {
            status: 412,
            path: `/${SPV}/buckets/blog/collections/articles/records/1`,
            body: {
              details: {
                existing: {title: "foo"}
              }
            }
          },
        ];
        sandbox.stub(root, "fetch")
          .returns(fakeServerResponse(200, {responses}));

        return executeBatch(fixtures)
          .should.eventually.become(responses);
      });
    });

    describe("Chunked requests", () => {
      // 4 operations, one more than the test limit which is 3
      const fixtures = [
        {id: 1, title: "foo"},
        {id: 2, title: "bar"},
        {id: 3, title: "baz"},
        {id: 4, title: "qux"},
      ];

      it("should chunk batch requests", () => {
        sandbox.stub(root, "fetch")
          .onFirstCall().returns(fakeServerResponse(200, {
            responses: [
              {status: 200, body: {data: 1}},
              {status: 200, body: {data: 2}},
              {status: 200, body: {data: 3}},
            ]
          }))
          .onSecondCall().returns(fakeServerResponse(200, {
            responses: [
              {status: 200, body: {data: 4}},
            ]
          }));
        return executeBatch(fixtures)
          .then(res => res.map(response => response.body.data))
          .should.become([1, 2, 3, 4]);
      });

      it("should not chunk batch requests if setting is falsy", () => {
        api.fetchServerSettings.returns(Promise.resolve({
          "batch_max_requests": null
        }));
        sandbox.stub(root, "fetch").returns(fakeServerResponse(200, {
          responses: []
        }));
        return executeBatch(fixtures)
          .then(_ => sinon.assert.calledOnce(fetch));
      });

      it("should map initial records to conflict objects", () => {
        sandbox.stub(root, "fetch")
          .onFirstCall().returns(fakeServerResponse(200, {
            responses: [
              {status: 412, body: {details: {existing: {id: 1}}}},
              {status: 412, body: {details: {existing: {id: 2}}}},
              {status: 412, body: {}},
            ]
          }))
          .onSecondCall().returns(fakeServerResponse(200, {
            responses: [
              {status: 412, body: {details: {existing: {id: 4}}}},
            ]
          }));
        return executeBatch(fixtures)
          .then(res => res.map(response => response.status))
          .should.become([412, 412, 412, 412]);
      });

      it("should chunk batch requests concurrently", () => {
        sandbox.stub(root, "fetch")
          .onFirstCall().returns(new Promise(resolve => {
            setTimeout(() => {
              resolve(fakeServerResponse(200, {
                responses: [
                  {status: 200, body: {data: 1}},
                  {status: 200, body: {data: 2}},
                  {status: 200, body: {data: 3}},
                ]
              }));
            }, 100);
          }))
          .onSecondCall().returns(new Promise(resolve => {
            setTimeout(() => {
              resolve(fakeServerResponse(200, {
                responses: [
                  {status: 200, body: {data: 4}},
                ]
              }));
            }, 5);
          }));
        return executeBatch(fixtures)
          .then(res => res.map(response => response.body.data))
          .should.become([1, 2, 3, 4]);
      });
    });

    describe("Aggregate mode", () => {
      const fixtures = [
        {title: "art1"},
        {title: "art2"},
        {title: "art3"},
        {title: "art4"},
      ];

      it("should resolve with an aggregated result object", () => {
        const responses = [];
        sandbox.stub(root, "fetch")
          .returns(fakeServerResponse(200, {responses}));
        const batchModule = require("../src/batch");
        const aggregate = sandbox.stub(batchModule, "aggregate");

        return executeBatch(fixtures, {aggregate: true})
          .then(_ => {
            sinon.assert.calledWith(aggregate, responses);
          });
      });
    });
  });

  /** @test {KintoClient#listBuckets} */
  describe("#listBuckets()", () => {
    beforeEach(() => {
      sandbox.stub(api, "execute").returns(Promise.resolve());
    });

    it("should execute expected request", () => {
      api.listBuckets();

      sinon.assert.calledWithMatch(api.execute, {
        path: "/buckets",
      });
    });

    it("should support passing custom headers", () => {
      api.optionHeaders = {Foo: "Bar"};
      api.listBuckets({headers: {Baz: "Qux"}});

      sinon.assert.calledWithMatch(api.execute, {
        headers: {Foo: "Bar", Baz: "Qux"}
      });
    });
  });

  /** @test {KintoClient#listRecords} */
  describe("#listRecords()", () => {
    beforeEach(() => {
      sandbox.stub(api, "execute").returns(Promise.resolve());
    });

    it("should execute expected request", () => {
      api.listRecords("foo");

      sinon.assert.calledWithMatch(api.execute, {
        path: "/buckets/default/collections/foo/records?_sort=-last_modified",
      });
    });
  });

  /** @test {KintoClient#getRecord} */
  describe("#getRecord()", () => {
    beforeEach(() => {
      sandbox.stub(api, "execute").returns(Promise.resolve());
    });

    it("should execute expected request", () => {
      api.getRecord("foo", 42);

      sinon.assert.calledWithMatch(api.execute, {
        path: "/buckets/default/collections/foo/records/42",
      });
    });
  });

  /** @test {KintoClient#createBucket} */
  describe("#createBucket", () => {
    beforeEach(() => {
      sandbox.stub(requests, "createBucket");
      sandbox.stub(api, "execute").returns(Promise.resolve());
    });

    it("should execute expected request", () => {
      api.createBucket("foo");

      sinon.assert.calledWithMatch(requests.createBucket, "foo", {
        headers: {},
        safe: false,
      });
    });

    it("should accept a safe option", () => {
      api.createBucket("foo", {safe: true});

      sinon.assert.calledWithMatch(requests.createBucket, "foo", {
        safe: true
      });
    });

    it("should extend request headers with optional ones", () => {
      api.optionHeaders = {Foo: "Bar"};

      api.createBucket("foo", {headers: {Baz: "Qux"}});

      sinon.assert.calledWithMatch(requests.createBucket, "foo", {
        headers: {Foo: "Bar", Baz: "Qux"}
      });
    });
  });

  /** @test {KintoClient#listCollections} */
  describe("#listCollections()", () => {
    const data = [
      {id: "c1", last_modified: 1},
      {id: "c2", last_modified: 2},
    ];

    beforeEach(() => {
      sandbox.stub(api, "execute").returns(Promise.resolve({json: {data}}));
    });

    it("should execute expected request", () => {
      api.listCollections("buck");

      sinon.assert.calledWithMatch(api.execute, {
        path: "/buckets/buck/collections",
      });
    });

    it("should accept a headers option", () => {
      api.listCollections("buck", {headers: {Foo: "Bar"}});

      sinon.assert.calledWithMatch(api.execute, {
        headers: {Foo: "Bar"}
      });
    });

    it("should retrieve the list of collections for a bucket", () => {
      return api.listCollections()
        .should.become(data);
    });
  });

  /** @test {KintoClient#createCollection} */
  describe("#createCollection()", () => {
    beforeEach(() => {
      sandbox.stub(requests, "createCollection");
      sandbox.stub(api, "execute").returns(Promise.resolve());
    });

    it("should execute expected request", () => {
      api.createCollection();

      sinon.assert.calledWithExactly(requests.createCollection, undefined, {
        bucket: "default",
        headers: {},
        safe: false,
      });
    });

    it("should accept a safe option", () => {
      api.createCollection({}, {safe: true});

      sinon.assert.calledWithMatch(requests.createCollection, {}, {
        safe: true
      });
    });

    it("should use instance default bucket option", () => {
      api.defaultBucket = "custom";

      api.createCollection({});

      sinon.assert.calledWithMatch(requests.createCollection, {}, {
        bucket: "custom"
      });
    });

    it("should allow overriding the default instance bucket option", () => {
      api.defaultBucket = "custom";

      api.createCollection({bucket: "myblog"});

      sinon.assert.calledWithMatch(requests.createCollection, {
        bucket: "myblog"
      });
    });

    it("should extend request headers with optional ones", () => {
      api.optionHeaders = {Foo: "Bar"};

      api.createCollection({}, {headers: {Baz: "Qux"}});

      sinon.assert.calledWithMatch(requests.createCollection, {}, {
        headers: {Foo: "Bar", Baz: "Qux"}
      });
    });
  });

  /** @test {KintoClient#updateCollection} */
  describe("#updateCollection()", () => {
    const metadata = {sampleData: 1};

    beforeEach(() => {
      sandbox.stub(requests, "updateCollection");
      sandbox.stub(api, "execute").returns(Promise.resolve());
    });

    it("should execute expected request", () => {
      api.updateCollection("plop", metadata);

      sinon.assert.calledWithExactly(requests.updateCollection, "plop", metadata, {
        bucket: "default",
        headers: {},
        safe: false,
      });
    });

    it("should accept a safe option", () => {
      api.updateCollection("plop", metadata, {safe: true});

      sinon.assert.calledWithMatch(requests.updateCollection, "plop", metadata, {
        safe: true
      });
    });

    it("should accept a patch option", () => {
      api.updateCollection("plop", metadata, {patch: true});

      sinon.assert.calledWithMatch(requests.updateCollection, "plop", metadata, {
        patch: true
      });
    });

    it("should use instance default bucket option", () => {
      api.defaultBucket = "custom";

      api.updateCollection("plop", metadata);

      sinon.assert.calledWithMatch(requests.updateCollection, "plop", metadata, {
        bucket: "custom"
      });
    });

    it("should allow overriding the default instance bucket option", () => {
      api.defaultBucket = "custom";

      api.updateCollection("plop", metadata, {bucket: "myblog"});

      sinon.assert.calledWithMatch(requests.updateCollection, "plop", metadata, {
        bucket: "myblog"
      });
    });

    it("should extend request headers with optional ones", () => {
      api.optionHeaders = {Foo: "Bar"};

      api.updateCollection("plop", metadata, {headers: {Baz: "Qux"}});

      sinon.assert.calledWithMatch(requests.updateCollection, "plop", metadata, {
        headers: {Foo: "Bar", Baz: "Qux"}
      });
    });

    it("should accept a permissions option", () => {
      const permissions = {permissions: {write: ["github:n1k0"]}};

      api.updateCollection("plop", metadata, {permissions});

      sinon.assert.calledWithMatch(requests.updateCollection, "plop", metadata, {
        permissions
      });
    });

    it("should accept a schema option", () => {
      const schema = {title: "boo"};

      api.updateCollection("plop", metadata, {schema});

      sinon.assert.calledWithMatch(requests.updateCollection, "plop", metadata, {
        schema
      });
    });
  });

  /** @test {KintoClient#deleteCollection} */
  describe("#deleteCollection()", () => {
    beforeEach(() => {
      sandbox.stub(requests, "deleteCollection");
      sandbox.stub(api, "execute").returns(Promise.resolve());
    });

    it("should execute expected request", () => {
      api.deleteCollection("plop");

      sinon.assert.calledWithExactly(requests.deleteCollection, "plop", {
        bucket: "default",
        headers: {},
        safe: false,
      });
    });

    it("should accept a safe option", () => {
      api.deleteCollection("plop", {safe: true});

      sinon.assert.calledWithMatch(requests.deleteCollection, "plop", {
        safe: true
      });
    });

    it("should use instance default bucket option", () => {
      api.defaultBucket = "custom";

      api.deleteCollection("plop");

      sinon.assert.calledWithMatch(requests.deleteCollection, "plop", {
        bucket: "custom"
      });
    });

    it("should allow overriding the default instance bucket option", () => {
      api.defaultBucket = "custom";

      api.deleteCollection("plop", {bucket: "myblog"});

      sinon.assert.calledWithMatch(requests.deleteCollection, "plop", {
        bucket: "myblog"
      });
    });

    it("should extend request headers with optional ones", () => {
      api.optionHeaders = {Foo: "Bar"};

      api.deleteCollection("plop", {headers: {Baz: "Qux"}});

      sinon.assert.calledWithMatch(requests.deleteCollection, "plop", {
        headers: {Foo: "Bar", Baz: "Qux"}
      });
    });
  });

  /** @test {KintoClient#getCollection} */
  describe("#getCollection()", () => {
    beforeEach(() => {
      sandbox.stub(api, "execute").returns(Promise.resolve());
    });

    it("should execute expected request", () => {
      api.getCollection("foo");

      sinon.assert.calledWithMatch(api.execute, {
        path: "/buckets/default/collections/foo",
      });
    });

    it("should use instance default bucket option", () => {
      api.defaultBucket = "custom";

      api.getCollection("foo");

      sinon.assert.calledWithMatch(api.execute, {
        path: "/buckets/custom/collections/foo",
      });
    });

    it("should allow overriding the default instance bucket option", () => {
      api.defaultBucket = "custom";

      api.getCollection("foo", {bucket: "myblog"});

      sinon.assert.calledWithMatch(api.execute, {
        path: "/buckets/myblog/collections/foo"
      });
    });
  });

  /** @test {KintoClient#getBucket} */
  describe("#getBucket()", () => {
    beforeEach(() => {
      sandbox.stub(api, "execute").returns(Promise.resolve());
    });

    it("should execute expected request", () => {
      api.getBucket("foo");

      sinon.assert.calledWithMatch(api.execute, {
        path: "/buckets/foo",
      });
    });
  });

  /** @test {KintoClient#updateBucket} */
  describe("#updateBucket", () => {
    beforeEach(() => {
      sandbox.stub(requests, "updateBucket");
      sandbox.stub(api, "execute").returns(Promise.resolve());
    });

    it("should execute expected request", () => {
      api.updateBucket("foo", {});

      sinon.assert.calledWithMatch(requests.updateBucket, "foo", {}, {
        headers: {},
        safe: false,
      });
    });

    it("should accept a safe option", () => {
      api.updateBucket("foo", {}, {safe: true});

      sinon.assert.calledWithMatch(requests.updateBucket, "foo", {}, {
        safe: true
      });
    });

    it("should use instance default bucket option", () => {
      api.defaultBucket = "custom";

      api.updateBucket("foo", {});

      sinon.assert.calledWithMatch(requests.updateBucket, "foo", {}, {
        bucket: "custom"
      });
    });

    it("should allow overriding the default instance bucket option", () => {
      api.defaultBucket = "custom";

      api.updateBucket("foo", {}, {bucket: "myblog"});

      sinon.assert.calledWithMatch(requests.updateBucket, "foo", {}, {
        bucket: "myblog"
      });
    });

    it("should extend request headers with optional ones", () => {
      api.optionHeaders = {Foo: "Bar"};

      api.updateBucket("foo", {}, {headers: {Baz: "Qux"}});

      sinon.assert.calledWithMatch(requests.updateBucket, "foo", {}, {
        headers: {Foo: "Bar", Baz: "Qux"}
      });
    });

    it("should send metadata along the request", () => {
      api.updateBucket("foo", {a: 1});

      sinon.assert.calledWithMatch(requests.updateBucket, "foo", {a: 1});
    });
  });

  /** @test {KintoClient#createRecord} */
  describe("#createRecord()", () => {
    const record = {title: "bar"};

    beforeEach(() => {
      sandbox.stub(requests, "createRecord");
      sandbox.stub(api, "execute").returns(Promise.resolve());
    });

    it("should execute expected request", () => {
      api.createRecord("foo", record);

      sinon.assert.calledWithExactly(requests.createRecord, "foo", record, {
        bucket: "default",
        headers: {},
        safe: false,
      });
    });

    it("should accept a safe option", () => {
      api.createRecord("foo", record, {safe: true});

      sinon.assert.calledWithMatch(requests.createRecord, "foo", record, {
        safe: true
      });
    });

    it("should use instance default bucket option", () => {
      api.defaultBucket = "custom";

      api.createRecord("foo", record);

      sinon.assert.calledWithMatch(requests.createRecord, "foo", record, {
        bucket: "custom"
      });
    });

    it("should allow overriding the default instance bucket option", () => {
      api.defaultBucket = "custom";

      api.createRecord("foo", record, {bucket: "myblog"});

      sinon.assert.calledWithMatch(requests.createRecord, "foo", record, {
        bucket: "myblog"
      });
    });

    it("should extend request headers with optional ones", () => {
      api.optionHeaders = {Foo: "Bar"};

      api.createRecord("foo", record, {headers: {Baz: "Qux"}});

      sinon.assert.calledWithMatch(requests.createRecord, "foo", record, {
        headers: {Foo: "Bar", Baz: "Qux"}
      });
    });
  });

  /** @test {KintoClient#updateRecord} */
  describe("#updateRecord()", () => {
    const record = {id: 1, title: "bar"};

    beforeEach(() => {
      sandbox.stub(requests, "updateRecord");
      sandbox.stub(api, "execute").returns(Promise.resolve());
    });

    it("should execute expected request", () => {
      api.updateRecord("foo", record);

      sinon.assert.calledWithExactly(requests.updateRecord, "foo", record, {
        bucket: "default",
        headers: {},
        safe: false,
      });
    });

    it("should accept a safe option", () => {
      api.updateRecord("foo", record, {safe: true});

      sinon.assert.calledWithMatch(requests.updateRecord, "foo", record, {
        safe: true
      });
    });

    it("should accept a patch option", () => {
      api.updateRecord("foo", record, {patch: true});

      sinon.assert.calledWithMatch(requests.updateRecord, "foo", record, {
        patch: true
      });
    });

    it("should use instance default bucket option", () => {
      api.defaultBucket = "custom";

      api.updateRecord("foo", record);

      sinon.assert.calledWithMatch(requests.updateRecord, "foo", record, {
        bucket: "custom"
      });
    });

    it("should allow overriding the default instance bucket option", () => {
      api.defaultBucket = "custom";

      api.updateRecord("foo", record, {bucket: "myblog"});

      sinon.assert.calledWithMatch(requests.updateRecord, "foo", record, {
        bucket: "myblog"
      });
    });

    it("should extend request headers with optional ones", () => {
      api.optionHeaders = {Foo: "Bar"};

      api.updateRecord("foo", record, {headers: {Baz: "Qux"}});

      sinon.assert.calledWithMatch(requests.updateRecord, "foo", record, {
        headers: {Foo: "Bar", Baz: "Qux"}
      });
    });
  });

  /** @test {KintoClient#deleteRecord} */
  describe("#deleteRecord()", () => {
    beforeEach(() => {
      sandbox.stub(requests, "deleteRecord");
      sandbox.stub(api, "execute").returns(Promise.resolve());
    });

    it("should execute expected request", () => {
      api.deleteRecord("foo", 42);

      sinon.assert.calledWithExactly(requests.deleteRecord, "foo", 42, {
        bucket: "default",
        headers: {},
        safe: false,
      });
    });

    it("should accept a safe option", () => {
      api.deleteRecord("foo", 42, {safe: true});

      sinon.assert.calledWithMatch(requests.deleteRecord, "foo", 42, {
        safe: true
      });
    });

    it("should use instance default bucket option", () => {
      api.defaultBucket = "custom";

      api.deleteRecord("foo", 42);

      sinon.assert.calledWithMatch(requests.deleteRecord, "foo", 42, {
        bucket: "custom"
      });
    });

    it("should allow overriding the default instance bucket option", () => {
      api.defaultBucket = "custom";

      api.deleteRecord("foo", 42, {bucket: "myblog"});

      sinon.assert.calledWithMatch(requests.deleteRecord, "foo", 42, {
        bucket: "myblog"
      });
    });

    it("should extend request headers with optional ones", () => {
      api.optionHeaders = {Foo: "Bar"};

      api.deleteRecord("foo", 42, {headers: {Baz: "Qux"}});

      sinon.assert.calledWithMatch(requests.deleteRecord, "foo", 42, {
        headers: {Foo: "Bar", Baz: "Qux"}
      });
    });
  });
});
