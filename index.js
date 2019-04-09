const hapi = require('hapi');
const Boom = require('boom');
const yar = require('yar');
const vision = require('vision');
const catboxRedis = require('catbox-redis');
const handlebars = require('handlebars');

function outputHelper(request, name) {
  return {
    page: name,
    auth: request.auth.isAuthenticated,
    yar: JSON.stringify([request.yar.id, request.yar.get('data')]),
    credentials: JSON.stringify(request.auth.credentials)
  };
}

async function bootstrap() {
  const oneDay = 86400000;
  const partition = 'mycatbox';
  const segment = 'myyar';
  const cookie = 'my-yar-cookie';
  // make a server, separate cache to keep the reference to it
  //  (could be done by asking server.cache as well)
  const cache = new catboxRedis({partition});
  const server = hapi.Server({
    port: 3000,
    cache: [
      {
        name: 'redisCache',
        engine: cache
      }
    ]
  });

  // authentication part: yar handles session via cookie.
  // Only session. Not auth.
  // 1. define the logics
  server.auth.scheme('my-scheme', function (server,options) {
    return {
      authenticate: function (request, h) {
        // check our flag - yar's content comes from Redis
        const data = request.yar.get('data');
        if (data && data.auth) {
          return h.authenticated({credentials: data.username});
        }
        throw Boom.unauthorized('Please GTFO.');
      }
    };
  });
  // 2. bind the logics to a strategy
  server.auth.strategy('my-strategy', 'my-scheme');
  // 3. let's enforce auth for EVERY route, UNLESS explicitly stated otherwise
  server.auth.default('my-strategy');

  // register Yar and other stuff we don't care about
  await server.register([
    {
      plugin: yar,
      options: {
        name: cookie,
        maxCookieSize: 0, // force server-side storage only
        cache: {
          cache: 'redisCache',
          segment: segment,
          expiresIn: oneDay // server-sided
        },
        cookieOptions: {
          password: 'HapiJS + Yar with Redis cache, toying around',
          isSameSite: 'Lax',
          isSecure: false,
          ttl: oneDay // client-sided
        }
      }
    },
    vision
  ]);

  // define our view system, we don't care about that
  server.views({
    engines: {
      html: handlebars
    },
    relativeTo: __dirname,
    path: 'templates',
    layout: true,
    layoutPath: 'templates'
  });

  // extension point for "yarring" routes (i.e. routes that alter the cookie and/or Redis data)
  // in these cases we need to re-work the TTLs
  server.ext({
    type: 'onPreResponse',
    options: {
      after: ['yar']
    },
    method: function (request, h) {
      if (!request.route.settings.app.yarring) {
        return h.continue;
      }
      if (request.yar.get('data').remember) {
        const fullId = {
          segment: segment,
          id: request.yar.id
        }
        cache.get(fullId).then((cached) => {
          cache.set(fullId, cached.item, oneDay * 365);
        })
        // this override only works because we store everything on
        //  server side (mind the 2nd arg)
        h.state(cookie, {id: request.yar.id}, {ttl: oneDay * 365});
      }
      return h.continue;
    }
  });

  // routing
  server.route([
    {
      // base route, open bar
      method: 'GET',
      path: '/',
      options: {
        auth: {
          mode: 'try'
        },
        handler: function (request, h) {
          return h.view('default', outputHelper(request, 'default page'));
        }
      }
    },
    {
      method: 'GET',
      path: '/login',
      options: {
        auth: {
          mode: 'try'
        },
        handler: function (request, h) {
          return h.view('login', outputHelper(request, 'login page'));
        }
      }
    },
    {
      method: 'POST',
      path: '/login',
      options: {
        app: {
          yarring: true, // flagging the login method for cookie post-processing
        },
        auth: {
          mode: 'try'
        },
        handler: function (request, h) {
          const { username, password, remember } = request.payload;
          request.yar.set('data', {
            username,
            remember: !!remember, // store this, as we need to decide on each request
            auth: true
          });
          return h.redirect('/');
        }
      }
    },
    // these routes below implictly have auth strategy enabled
    {
      method: 'GET',
      path: '/logout',
      options: {
        handler: function (request, h) {
          request.yar.clear('data');
          return h.redirect('/');
        }
      }
    },
    {
      method: 'GET',
      path: '/secured',
      options: {
        handler: function (request, h) {
          return h.view('secured', outputHelper(request, 'authenticated page'));
        }
      }
    },
    {
      method: 'GET',
      path: '/user',
      options: {
        handler: function (request, h) {
          const context = outputHelper(request, 'account page');
          // retrieve user's data from Yar/Redis/fast-enough-storage-for-this
          context.username = request.yar.get('data').username;
          return h.view('user', context);
        }
      }
    },
    {
      // should be a PUT, but for the sake of simplicity here...
      // just to see how an altered username gets reflected in Redis
      method: 'POST',
      path: '/user',
      options: {
        app: {
          yarring: true, // flagging the user update method for cookie post-processing
        },
        handler: function (request, h) {
          // when updating the entity, one needs to manually synchronize
          //  both datasets: since here we have no real DB, we only do the Redis part
          // in case several entry points are available to update a user,
          //  one might want to abstract the sync'ing logic for reusability
          const data = request.yar.get('data');
          data.username = request.payload.username
          request.yar.set('data', data);
          return h.redirect('/');
        }
      }
    }
  ]);


  server.start();
}

bootstrap();
