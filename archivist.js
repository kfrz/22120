import fs from 'fs';
import ws from 'ws';
import fetch from 'node-fetch';

// cache is a simple map
  // that holds the serialized requests
  // that are saved on disk
const Cache = new Map();
const ROOT_SESSION = 'browser';
const State = {
  Cache
}

const Archivist = { 
  collect, connect
}

const UNCACHED_BODY = Buffer.from('We have not saved this data').toString('base64');
const UNCACHED_CODE = 404;
const UNCACHED_HEADERS = [
  { name: 'Content-type', value: 'text/plain' },
  { name: 'Content-length', value: '26' }
];

export default Archivist;

async function collect({chrome_port:port, mode} = {}) {
  const {send, on, ons} = await connect({port});

  // send commands and listen to events
    // so that we can intercept every request
    // and cache it and if it's in cache then we
    // can pause the request (so it does not go to network)
    // and serve from cache
    // effectively off-lining the site

  // question
    // can we attach to browser target and catch everything
    // or do we need to handle sessions ? 

  let requestStage;
  
  if ( mode == 'save' ) {
    requestStage = "Response";
    setInterval(saveCache, 10000);
  } else if ( mode == 'serve' ) {
    requestStage = "Request";
    State.Cache = new Map(JSON.parse(fs.readFileSync('cache.json')));
  } else {
    throw new TypeError(`Must specify mode`);
  }

  send("Fetch.enable", {
    patterns: [
      {
        urlPattern: "http*://*", 
        requestStage
      }
    ]
  });
  on("Fetch.requestPaused", cacheRequest);

  async function cacheRequest(pausedRequest) {
    const {requestId, request, responseStatusCode, responseHeaders} = pausedRequest;
    const key = serializeRequest(request);
    if ( mode == 'serve' ) {
      if ( State.Cache.has(key) ) {
        let {body, responseCode, responseHeaders} = State.Cache.get(key);
        responseCode = responseCode || 200;
        console.log("Fulfilling", key, responseCode, responseHeaders, body.slice(0,140));
        await send("Fetch.fulfillRequest", {
          requestId, body, responseCode, responseHeaders
        });
      } else {
        console.log("Sending cache stub", key);
        await send("Fetch.fulfillRequest", {
          requestId, body:UNCACHED_BODY, responseCode:UNCACHED_CODE, responseHeaders:UNCACHED_HEADERS
        });
      } 
    } else if ( mode == 'save' ) {
      const response = {responseCode: responseStatusCode, responseHeaders};
      const resp = await send("Fetch.getResponseBody", {requestId});
      if ( !! resp ) {
        let {body, base64Encoded} = resp;
        if ( ! base64Encoded ) {
          body = Buffer.from(body);
          body = body.toString('base64');
        }
        response.body = body;
      } else {
        response.body = '';
      }
      State.Cache.set(key, response);
      await send("Fetch.continueRequest", {requestId});
    }
  }

  function serializeRequest(request) {
    const {url, urlFragment, method, headers, postData, hasPostData} = request;

    let sortedHeaders = '';
    for( const key of Object.keys(headers).sort() ) {
      sortedHeaders += `${key}:${headers[key]}/`;
    }

    return `${method}${url}`;
    //return `${url}${urlFragment}:${method}:${sortedHeaders}:${postData}:${hasPostData}`;
  }

  function saveCache() {
    fs.writeFileSync("cache.json", JSON.stringify([...State.Cache.entries()]));
  }
}

async function connect({port:port = 9222} = {}) {
  const {webSocketDebuggerUrl} = await fetch(`http://localhost:${port}/json/version`).then(r => r.json());
  const socket = new ws(webSocketDebuggerUrl);
  const Resolvers = {};
  const Handlers = {};
  socket.on('message', handle);
  let id = 0;
  
  async function send(method, params = {}, sessionId) {
    const message = {
      method, params, sessionId, 
      id: ++id
    };
    const key = `${sessionId||ROOT_SESSION}:${message.id}`;
    let resolve;
    const promise = new Promise(res => resolve = res);
    Resolvers[key] = resolve; 
    socket.send(JSON.stringify(message));
    return promise;
  }

  async function handle(message) {
    const stringMessage = message;
    message = JSON.parse(message);
    if ( message.error ) {
      console.warn(message);
    }
    const {sessionId} = message;
    const {method, params} = message;
    const {id, result} = message;

    if ( id ) {
      const key = `${sessionId||ROOT_SESSION}:${id}`;
      const resolve = Resolvers[key];
      if ( ! resolve ) {
        console.warn(`No resolver for key`, key, stringMessage.slice(0,140));
      } else {
        Resolvers[key] = undefined;
        try {
          await resolve(result);
        } catch(e) {
          console.warn(`Resolver failed`, e, key, stringMessage.slice(0,140), resolve);
        }
      }
    } else if ( method ) {
      const listeners = Handlers[method];
      if ( Array.isArray(listeners) ) {
        for( const func of listeners ) {
          try {
            await func({message, sessionId});
          } catch(e) {
            console.warn(`Listener failed`, method, e, func.toString().slice(0,140), stringMessage.slice(0,140));
          }
        }
      }
    } else {
      console.warn(`Unknown message on socket`, message);
    }
  }

  function on(method, handler) {
    let listeners = Handlers[method]; 
    if ( ! listeners ) {
      Handlers[method] = listeners = [];
    }
    listeners.push(wrap(handler));
  }

  function ons(method, handler) {
    let listeners = Handlers[method]; 
    if ( ! listeners ) {
      Handlers[method] = listeners = [];
    }
    listeners.push(handler);
  }

  function wrap(fn) {
    return ({message, sessionId}) => fn(message.params)
  }

  let resolve;
  const promise = new Promise(res => resolve = res);

  socket.on('open', () => resolve());

  await promise;

  return {
    send,
    on, ons
  }
}

