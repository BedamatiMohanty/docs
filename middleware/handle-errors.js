import FailBot from '../lib/failbot.js'
import { nextApp } from './next.js'
import { setFastlySurrogateKey, SURROGATE_ENUMS } from './set-fastly-surrogate-key.js'
import { cacheControlFactory } from './cache-control.js'

const cacheControl = cacheControlFactory(60) // 1 minute

function shouldLogException(error) {
  const IGNORED_ERRORS = [
    // avoid sending CSRF token errors (from bad-actor POST requests)
    'EBADCSRFTOKEN',
    // Client connected aborted
    'ECONNRESET',
  ]

  if (IGNORED_ERRORS.includes(error.code)) {
    return false
  }

  // We should log this exception
  return true
}

async function logException(error, req) {
  if (process.env.NODE_ENV !== 'test' && shouldLogException(error)) {
    await FailBot.report(error, {
      path: req.path,
    })
  }
}

export default async function handleError(error, req, res, next) {
  // When you run tests that use things doing get() requests in
  // our supertest handler, if something goes wrong anywhere in the app
  // and its middlewares, you get a 500 but the error is never displayed
  // anywhere. So this is why we log it additionally.
  // Note, not using console.error() because it's arguably handled.
  // Some tests might actually expect a 500 error.

  if (req.path.startsWith('/assets') || req.path.startsWith('/_next/static')) {
    // By default, Fastly will cache 404 responses unless otherwise
    // told not to.
    // See https://docs.fastly.com/en/guides/how-caching-and-cdns-work#http-status-codes-cached-by-default
    // Most of the time, that's a good thing! Especially, if bombarded
    // for some static asset that we don't have.
    // E.g. `ab -n 10000 https://docs.github.com/assets/doesnotexist.png`
    // But due to potential timing issue related to how the servers start,
    // what might happen is that a new insteance comes up that
    // contains `<script src="/_next/static/foo.1234.css">` in the HTML.
    // The browser then proceeds to request /_next/static/foo.1234.css
    // but this time it could be unluckily routed to a different instance
    // that hasn't yet been upgraded, so they get a 404. And the CDN will
    // notice this and cache it.
    // Setting a tiny cache gets us a good compromise. It protects us
    // against most stamping herds on 404s (thank you CDN!) but it also
    // clears itself if you get that unlucky timing issue with rolling
    // instances in a new deployment.
    // For more background see issue 1553.
    cacheControl(res)
    // Undo the cookie setting that CSRF sets.
    res.removeHeader('set-cookie')
    // Makes sure the surrogate key is NOT the manual one if it failed.
    // This basically unsets what was assumed in the beginning of
    // loading all the middlewares.
    setFastlySurrogateKey(res, SURROGATE_ENUMS.DEFAULT)
  } else if (process.env.NODE_ENV === 'test') {
    console.warn('An error occurrred in some middleware handler', error)
  }

  try {
    // If the headers have already been sent or the request was aborted...
    if (res.headersSent || req.aborted) {
      // Report to Failbot
      await logException(error, req)

      // We MUST delegate to the default Express error handler
      return next(error)
    }

    if (!req.context) {
      req.context = {}
    }
    // display error on the page in development and staging, but not in production
    if (process.env.HEROKU_PRODUCTION_APP !== 'true') {
      req.context.error = error
    }

    // Special handling for when a middleware calls `next(404)`
    if (error === 404) {
      return nextApp.render404(req, res)
    }

    // If the error contains a status code, just send that back. This is usually
    // from a middleware like `express.json()` or `csrf`.
    if (error.statusCode || error.status) {
      return res.sendStatus(error.statusCode || error.status)
    }

    if (process.env.NODE_ENV !== 'test') {
      console.error('500 error!', req.path)
      console.error(error)
    }

    res.statusCode = 500
    nextApp.renderError(error, req, res, req.path)

    // Report to Failbot AFTER responding to the user
    await logException(error, req)
  } catch (error) {
    console.error('An error occurred in the error handling middleware!', error)
    return next(error)
  }
}
