/*
 * Copyright 2018 Google LLC. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 */

/**
 * @fileoverview Exports Koa middleware to serve the Chrome Dev Summit site at '/'.
 */

'use strict';

const fs = require('fs');
const flat = require('./deps/router.js');
const hbs = require('koa-hbs');
const Koa = require('koa');
const mount = require('koa-mount');
const policy = require('./deps/policy.js');
const less = require('less');
const calendar = require('./deps/calendar.js')
const send = require('koa-send');
const serve = require('koa-static');
require('./helpers.js');  // side-effects only

const app = new Koa();
const isProd = (process.env.NODE_ENV === 'production');

const schedule = require('./schedule.json');
const days = calendar.days(schedule);

// NOTE: This is the current stage of the event, which is hard-coded. Stages supported are
// 'announce', signup' and 'event', there's no post-event yet.
const stage = 'announce';

// save policy string
const policyHeader = policy(isProd);

if (isProd) {
  app.use(mount('/res', serve('res')));        // runtime build assets
} else {
  app.use(mount('/static', serve('static')));  // app.yaml serves this in prod
  app.use(mount('/src', serve('src')));        // actual source folder
  app.use(mount('/node_modules', serve('node_modules')));
}

// In prod, we want to render AMP CSS from the generated file directly.
function readProdAmpCss() {
  const p = `${__dirname}/res/amp.css`;
  try {
    return fs.readFileSync(p);
  } catch (err) {
    // not found for some reason
  }
  return undefined;
}
const prodAmpCss = isProd ? readProdAmpCss() : undefined;
let fallbackProdAmpCss = undefined;

// Serve sw.js from top-level.
const sourcePrefix = isProd ? 'res' : 'src';
app.use(async (ctx, next) => {
  if (ctx.path === '/sw.js') {
    return send(ctx, `${sourcePrefix}/sw.js`);
  }
  return next();
});

app.use(hbs.middleware({
  viewPath: `${__dirname}/sections`,
  layoutsPath: `${__dirname}/templates`,
  partialsPath: `${__dirname}/partials`,
  extname: '.html',
}));

// Serve schedule.json from top-level.
app.use(async (ctx, next) => {
  if (ctx.path === '/schedule.json') {
    return send(ctx, `schedule.json`);
  }
  if (ctx.path === '/googlec6dfdf23945d0d0c.html') {
    return send(ctx, `googlec6dfdf23945d0d0c.html`);
  }
  if (ctx.path === '/sitemap.xml') {
    const basepath = mountUrl(ctx);
    const hostname = ctx.req.headers.host;
    const sitePrefix = (isProd ? 'https://' : 'http://') + hostname + basepath;

    ctx.type = 'text/xml';

    // ctx.render returns undefined, but bail early anyway
    return await ctx.render('_sitemap', {
      data: schedule,
      sitePrefix,
    });
  }

  return next();
});

const sections = fs.readdirSync(`${__dirname}/sections`)
    .map((section) => {
      const ch = section[0];
      if (section.endsWith('.html') && ch !== '_' && ch !== '.') {
        const out = section.substr(0, section.length - 5);
        return out === 'index' ? '' : out;
      }
    }).filter((x) => x !== undefined);

/**
 * Gets the URL prefix where this site is mounted with Koa, without the trailing /.
 * @param {!Object} ctx
 * @return {string}
 */
function mountUrl(ctx) {
  if (ctx.originalUrl === undefined) {
    return '';
  }
  const index = ctx.originalUrl.lastIndexOf(ctx.url);
  if (index === -1) {
    return '';
  }
  return ctx.originalUrl.slice(0, index);
}

app.use(flat(async (ctx, next, path, rest) => {
  if (sections.indexOf(path) === -1) {
    return next();
  }

  let data;
  let bodyClass;

  // derive the mount path from Koa, so this doesn't need to have it as a const
  const basepath = mountUrl(ctx);
  const hostname = ctx.req.headers.host;
  const sitePrefix = (isProd ? 'https://' : 'http://') + hostname + basepath;

  const year = 2019;
  const scope = {
    year,
    eventNo: year - 2012,  // 2019 is 7th
    dateString: '11—12 November 2019',
    prod: isProd,
    base: basepath,
    layout: 'devsummit',
    ua: 'UA-41980257-1',
    conversion: 935743779,
    canonicalUrl: `${sitePrefix}/${path}`,
    path,
    sourcePrefix,
    days,
    stage,
    links: {
      interestForm: 'https://docs.google.com/forms/d/e/1FAIpQLSdqEfT0jfgRNIGqibWxBe8X1Dt0a2FcHdituhRhG1tNGL1sBQ/viewform',
      livestreamForm: 'https://goo.gl/forms/738tmXWSbEdIWHf63',
    },
  };

  if (rest) {
    scope.canonicalUrl += `/${rest}`;
    // lookup schedule
    data = schedule.sessions[rest];
    path = '_amp-session';
    bodyClass = 'schedule-popup';

    // session not found, checking for potential speaker
    if (!data) {
      data = schedule.speakers[rest];
      path = '_amp-speaker';
      bodyClass = 'speaker-popup';
    }
    
    // no session, no pseaker or ID starts with _
    if (!data || rest.startsWith('_')) {
      return next();
    }

    let css = prodAmpCss || fallbackProdAmpCss;
    if (css === undefined) {
      // We provide a "fake" file to Less.CSS, as otherwise it needs the file and its filename.
      const filename = `${__dirname}/static/styles/amp.less`;
      const result = await less.render(`@import '${filename}';`);
      css = result.css;

      if (isProd) {
        console.debug('saving rendered CSS to fallback in prod', css.length, 'bytes');
        fallbackProdAmpCss = css;
      }
    }

    // render AMP for first session load
    scope.layout = 'amp';
    scope.id = rest;
    scope.bodyClass = bodyClass;
    scope.sitePrefix = sitePrefix;
    scope.title = data.name || '';
    scope.time_label = data.time_label || '';
    scope.description = data.description || '',
    scope.youtube_id = data.youtube_id || false,
    scope.payload = data;
    scope.styles = css;
  }

  ctx.set('Feature-Policy', policyHeader);
  await ctx.render(path || 'index', scope);
}));

module.exports = app;
