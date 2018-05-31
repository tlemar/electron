const assert = require('assert')
const {expect} = require('chai')
const path = require('path')
const http = require('http')
const url = require('url')
const {ipcRenderer, remote} = require('electron')
const {app, session, getGuestWebContents, ipcMain, BrowserWindow, webContents} = remote
const {closeWindow} = require('./window-helpers')

const isCI = remote.getGlobal('isCi')
const nativeModulesEnabled = remote.getGlobal('nativeModulesEnabled')

/* Most of the APIs here don't use standard callbacks */
/* eslint-disable standard/no-callback-literal */

describe('<webview> tag', function () {
  this.timeout(3 * 60 * 1000)

  const fixtures = path.join(__dirname, 'fixtures')
  let webview = null
  let w = null

  const openTheWindow = async (...args) => {
    await closeTheWindow()
    w = new BrowserWindow(...args)
    return w
  }

  const closeTheWindow = () => {
    return closeWindow(w).then(() => { w = null })
  }

  const waitForEvent = (eventTarget, eventName) => {
    return new Promise((resolve) => {
      eventTarget.addEventListener(eventName, resolve, {once: true})
    })
  }

  const waitForOnce = (eventTarget, eventName) => {
    return new Promise((resolve) => {
      eventTarget.once(eventName, (...args) => resolve(args))
    })
  }

  const loadWebView = (webview, attributes = {}) => {
    for (const [name, value] of Object.entries(attributes)) {
      webview.setAttribute(name, value)
    }
    document.body.appendChild(webview)
    return waitForEvent(webview, 'did-finish-load')
  }

  const startLoadingWebViewAndWaitForMessage = (webview, attributes = {}) => {
    loadWebView(webview, attributes)  // Don't wait for load to be finished.
    return waitForEvent(webview, 'console-message')
  }

  beforeEach(() => {
    webview = new WebView()
  })

  afterEach(() => {
    if (!document.body.contains(webview)) {
      document.body.appendChild(webview)
    }
    webview.remove()

    return closeTheWindow()
  })

  it('works without script tag in page', async () => {
    await openTheWindow({show: false})
    w.loadURL('file://' + fixtures + '/pages/webview-no-script.html')
    await waitForOnce(ipcMain, 'pong')
  })

  it('is disabled when nodeIntegration is disabled', async () => {
    await openTheWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        preload: path.join(fixtures, 'module', 'preload-webview.js')
      }
    })

    w.loadURL(`file://${fixtures}/pages/webview-no-script.html`)
    const [, type] = await waitForOnce(ipcMain, 'webview')

    assert(type === 'undefined', 'WebView still exists')
  })

  it('is enabled when the webviewTag option is enabled and the nodeIntegration option is disabled', async () => {
    await openTheWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        preload: path.join(fixtures, 'module', 'preload-webview.js'),
        webviewTag: true
      }
    })

    w.loadURL(`file://${fixtures}/pages/webview-no-script.html`)
    const [, type] = await waitForOnce(ipcMain, 'webview')

    assert(type !== 'undefined', 'WebView is not created')
  })

  describe('src attribute', () => {
    it('specifies the page to load', async () => {
      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        src: `file://${fixtures}/pages/a.html`
      })
      assert.equal(message, 'a')
    })

    it('navigates to new page when changed', async () => {
      await loadWebView(webview, {
        src: `file://${fixtures}/pages/a.html`
      })

      webview.src = `file://${fixtures}/pages/b.html`

      const {message} = await waitForEvent(webview, 'console-message')
      assert.equal(message, 'b')
    })

    it('resolves relative URLs', async () => {
      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        src: '../fixtures/pages/e.html'
      })
      assert.equal(message, 'Window script is loaded before preload script')
    })

    it('ignores empty values', () => {
      assert.equal(webview.src, '')

      for (const emptyValue of ['', null, undefined]) {
        webview.src = emptyValue
        assert.equal(webview.src, '')
      }
    })
  })

  describe('nodeintegration attribute', () => {
    it('inserts no node symbols when not set', async () => {
      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        src: `file://${fixtures}/pages/c.html`
      })

      assert.equal(message, '{"require":"undefined","module":"undefined","process":"undefined","global":"undefined"}')
    })

    it('inserts node symbols when set', async () => {
      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        nodeintegration: 'on',
        src: `file://${fixtures}/pages/d.html`
      })

      assert.equal(message, '{"require":"function","module":"object","process":"object"}')
    })

    it('loads node symbols after POST navigation when set', async function () {
      // FIXME Figure out why this is timing out on AppVeyor
      if (process.env.APPVEYOR === 'True') {
        // FIXME(alexeykuzmin): Skip the test.
        this.skip()
        return
      }

      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        nodeintegration: 'on',
        src: `file://${fixtures}/pages/post.html`
      })

      assert.equal(message, '{"require":"function","module":"object","process":"object"}')
    })

    it('disables node integration on child windows when it is disabled on the webview', (done) => {
      app.once('browser-window-created', (event, window) => {
        assert.equal(window.webContents.getWebPreferences().nodeIntegration, false)
        done()
      })

      const src = url.format({
        pathname: `${fixtures}/pages/webview-opener-no-node-integration.html`,
        protocol: 'file',
        query: {
          p: `${fixtures}/pages/window-opener-node.html`
        },
        slashes: true
      })
      loadWebView(webview, {
        allowpopups: 'on',
        src
      })
    })

    it('loads native modules when navigation happens', async function () {
      if (!nativeModulesEnabled) {
        this.skip()
        return
      }

      await loadWebView(webview, {
        nodeintegration: 'on',
        src: `file://${fixtures}/pages/native-module.html`
      })

      webview.reload()

      const {message} = await waitForEvent(webview, 'console-message')
      assert.equal(message, 'function')
    })
  })

  describe('preload attribute', () => {
    it('loads the script before other scripts in window', async () => {
      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        preload: `${fixtures}/module/preload.js`,
        src: `file://${fixtures}/pages/e.html`
      })

      expect(message).to.be.a('string')
      expect(message).to.be.not.equal('Window script is loaded before preload script')
    })

    it('preload script can still use "process" and "Buffer" when nodeintegration is off', async () => {
      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        preload: `${fixtures}/module/preload-node-off.js`,
        src: `file://${fixtures}/api/blank.html`
      })

      const types = JSON.parse(message)
      expect(types).to.include({
        process: 'object',
        Buffer: 'function'
      })
    })

    it('preload script can require modules that still use "process" and "Buffer" when nodeintegration is off', async () => {
      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        preload: `${fixtures}/module/preload-node-off-wrapper.js`,
        src: `file://${fixtures}/api/blank.html`
      })

      const types = JSON.parse(message)
      expect(types).to.include({
        process: 'object',
        Buffer: 'function'
      })
    })

    it('receives ipc message in preload script', async () => {
      const message = 'boom!'

      webview.setAttribute('preload', `${fixtures}/module/preload-ipc.js`)
      webview.src = `file://${fixtures}/pages/e.html`
      document.body.appendChild(webview)

      await waitForEvent(webview, 'did-finish-load')
      webview.send('ping', message)
      const e = await waitForEvent(webview, 'ipc-message')

      assert.equal(e.channel, 'pong')
      assert.deepEqual(e.args, [message])
    })

    it('works without script tag in page', async () => {
      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        preload: `${fixtures}/module/preload.js`,
        src: `file://${fixtures}pages/base-page.html`
      })

      const types = JSON.parse(message)
      expect(types).to.include({
        require: 'function',
        module: 'object',
        process: 'object',
        Buffer: 'function'
      })
    })

    it('resolves relative URLs', async () => {
      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        preload: '../fixtures/module/preload.js',
        src: `file://${fixtures}/pages/e.html`
      })

      const types = JSON.parse(message)
      expect(types).to.include({
        require: 'function',
        module: 'object',
        process: 'object',
        Buffer: 'function'
      })
    })

    it('ignores empty values', () => {
      assert.equal(webview.preload, '')

      for (const emptyValue of ['', null, undefined]) {
        webview.preload = emptyValue
        assert.equal(webview.preload, '')
      }
    })
  })

  describe('httpreferrer attribute', () => {
    it('sets the referrer url', (done) => {
      const referrer = 'http://github.com/'
      const server = http.createServer((req, res) => {
        res.end()
        server.close()
        assert.equal(req.headers.referer, referrer)
        done()
      }).listen(0, '127.0.0.1', () => {
        const port = server.address().port
        loadWebView(webview, {
          httpreferrer: referrer,
          src: `http://127.0.0.1:${port}`
        })
      })
    })
  })

  describe('useragent attribute', () => {
    it('sets the user agent', async () => {
      const referrer = 'Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; AS; rv:11.0) like Gecko'
      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        src: `file://${fixtures}/pages/useragent.html`,
        useragent: referrer
      })
      assert.equal(message, referrer)
    })
  })

  describe('disablewebsecurity attribute', () => {
    it('does not disable web security when not set', async () => {
      const jqueryPath = path.join(__dirname, '/static/jquery-2.0.3.min.js')
      const src = `<script src='file://${jqueryPath}'></script> <script>console.log('ok');</script>`
      const encoded = btoa(unescape(encodeURIComponent(src)))

      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        src: `data:text/html;base64,${encoded}`
      })
      expect(message).to.be.a('string')
      expect(message).to.contain('Not allowed to load local resource')
    })

    it('disables web security when set', async () => {
      const jqueryPath = path.join(__dirname, '/static/jquery-2.0.3.min.js')
      const src = `<script src='file://${jqueryPath}'></script> <script>console.log('ok');</script>`
      const encoded = btoa(unescape(encodeURIComponent(src)))

      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        disablewebsecurity: '',
        src: `data:text/html;base64,${encoded}`
      })
      assert.equal(message, 'ok')
    })

    it('does not break node integration', async () => {
      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        disablewebsecurity: '',
        nodeintegration: 'on',
        src: `file://${fixtures}/pages/d.html`
      })
      assert.equal(message, '{"require":"function","module":"object","process":"object"}')
    })

    it('does not break preload script', async () => {
      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        disablewebsecurity: '',
        preload: `${fixtures}/module/preload.js`,
        src: `file://${fixtures}/pages/e.html`
      })
      assert.equal(message, '{"require":"function","module":"object","process":"object","Buffer":"function"}')
    })
  })

  describe('partition attribute', () => {
    it('inserts no node symbols when not set', async () => {
      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        partition: 'test1',
        src: `file://${fixtures}/pages/c.html`
      })
      assert.equal(message, '{"require":"undefined","module":"undefined","process":"undefined","global":"undefined"}')
    })

    it('inserts node symbols when set', async () => {
      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        nodeintegration: 'on',
        partition: 'test2',
        src: `file://${fixtures}/pages/d.html`
      })
      assert.equal(message, '{"require":"function","module":"object","process":"object"}')
    })

    it('isolates storage for different id', async () => {
      window.localStorage.setItem('test', 'one')

      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        partition: 'test3',
        src: `file://${fixtures}/pages/partition/one.html`
      })

      const parsedMessage = JSON.parse(message)
      expect(parsedMessage).to.include({
        numberOfEntries: 0,
        testValue: null
      })
    })

    it('uses current session storage when no id is provided', async () => {
      const testValue = 'one'
      window.localStorage.setItem('test', testValue)

      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        src: `file://${fixtures}/pages/partition/one.html`
      })

      const parsedMessage = JSON.parse(message)
      expect(parsedMessage).to.include({
        numberOfEntries: 1,
        testValue
      })
    })
  })

  describe('allowpopups attribute', () => {
    it('can not open new window when not set', async () => {
      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        src: `file://${fixtures}/pages/window-open-hide.html`
      })
      assert.equal(message, 'null')
    })

    it('can open new window when set', async () => {
      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        allowpopups: 'on',
        src: `file://${fixtures}/pages/window-open-hide.html`
      })
      assert.equal(message, 'window')
    })
  })

  describe('webpreferences attribute', () => {
    it('can enable nodeintegration', async () => {
      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        src: `file://${fixtures}/pages/d.html`,
        webpreferences: 'nodeIntegration'
      })
      assert.equal(message, '{"require":"function","module":"object","process":"object"}')
    })

    it('can disables web security and enable nodeintegration', async () => {
      const jqueryPath = path.join(__dirname, '/static/jquery-2.0.3.min.js')
      const src = `<script src='file://${jqueryPath}'></script> <script>console.log(typeof require);</script>`
      const encoded = btoa(unescape(encodeURIComponent(src)))

      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        src: `data:text/html;base64,${encoded}`,
        webpreferences: 'webSecurity=no, nodeIntegration=yes'
      })

      assert.equal(message, 'function')
    })

    it('can enable context isolation', (done) => {
      ipcMain.once('isolated-world', (event, data) => {
        assert.deepEqual(data, {
          preloadContext: {
            preloadProperty: 'number',
            pageProperty: 'undefined',
            typeofRequire: 'function',
            typeofProcess: 'object',
            typeofArrayPush: 'function',
            typeofFunctionApply: 'function'
          },
          pageContext: {
            preloadProperty: 'undefined',
            pageProperty: 'string',
            typeofRequire: 'undefined',
            typeofProcess: 'undefined',
            typeofArrayPush: 'number',
            typeofFunctionApply: 'boolean',
            typeofPreloadExecuteJavaScriptProperty: 'number',
            typeofOpenedWindow: 'object'
          }
        })
        done()
      })

      loadWebView(webview, {
        allowpopups: 'yes',
        preload: path.join(fixtures, 'api', 'isolated-preload.js'),
        src: `file://${fixtures}/api/isolated.html`,
        webpreferences: 'contextIsolation=yes'
      })
    })
  })

  describe('new-window event', () => {
    it('emits when window.open is called', async () => {
      loadWebView(webview, {
        src: `file://${fixtures}/pages/window-open.html`
      })
      const event = await waitForEvent(webview, 'new-window')

      assert.equal(event.url, 'http://host/')
      assert.equal(event.frameName, 'host')
    })

    it('emits when link with target is called', async () => {
      loadWebView(webview, {
        src: `file://${fixtures}/pages/target-name.html`
      })
      const event = await waitForEvent(webview, 'new-window')

      assert.equal(event.url, 'http://host/')
      assert.equal(event.frameName, 'target')
    })
  })

  describe('ipc-message event', () => {
    it('emits when guest sends a ipc message to browser', async () => {
      loadWebView(webview, {
        nodeintegration: 'on',
        src: `file://${fixtures}/pages/ipc-message.html`
      })
      const event = await waitForEvent(webview, 'ipc-message')

      assert.equal(event.channel, 'channel')
      assert.deepEqual(event.args, ['arg1', 'arg2'])
    })
  })

  describe('page-title-set event', () => {
    it('emits when title is set', async () => {
      loadWebView(webview, {
        src: `file://${fixtures}/pages/a.html`
      })
      const event = await waitForEvent(webview, 'page-title-set')

      assert.equal(event.title, 'test')
      assert(event.explicitSet)
    })
  })

  describe('page-favicon-updated event', () => {
    it('emits when favicon urls are received', async () => {
      loadWebView(webview, {
        src: `file://${fixtures}/pages/a.html`
      })
      const {favicons} = await waitForEvent(webview, 'page-favicon-updated')

      assert(favicons)
      assert.equal(favicons.length, 2)
      if (process.platform === 'win32') {
        assert(/^file:\/\/\/[A-Z]:\/favicon.png$/i.test(favicons[0]))
      } else {
        assert.equal(favicons[0], 'file:///favicon.png')
      }
    })
  })

  describe('will-navigate event', () => {
    it('emits when a url that leads to oustide of the page is clicked', async () => {
      loadWebView(webview, {
        src: `file://${fixtures}/pages/webview-will-navigate.html`
      })
      const {url} = await waitForEvent(webview, 'will-navigate')

      assert.equal(url, 'http://host/')
    })
  })

  describe('did-navigate event', () => {
    let p = path.join(fixtures, 'pages', 'webview-will-navigate.html')
    p = p.replace(/\\/g, '/')
    const pageUrl = url.format({
      protocol: 'file',
      slashes: true,
      pathname: p
    })

    it('emits when a url that leads to outside of the page is clicked', async () => {
      loadWebView(webview, {src: pageUrl})
      const {url} = await waitForEvent(webview, 'did-navigate')

      assert.equal(url, pageUrl)
    })
  })

  describe('did-navigate-in-page event', () => {
    it('emits when an anchor link is clicked', async () => {
      let p = path.join(fixtures, 'pages', 'webview-did-navigate-in-page.html')
      p = p.replace(/\\/g, '/')
      const pageUrl = url.format({
        protocol: 'file',
        slashes: true,
        pathname: p
      })
      loadWebView(webview, {src: pageUrl})
      const event = await waitForEvent(webview, 'did-navigate-in-page')
      assert.equal(event.url, `${pageUrl}#test_content`)
    })

    it('emits when window.history.replaceState is called', async () => {
      loadWebView(webview, {
        src: `file://${fixtures}/pages/webview-did-navigate-in-page-with-history.html`
      })
      const {url} = await waitForEvent(webview, 'did-navigate-in-page')
      assert.equal(url, 'http://host/')
    })

    it('emits when window.location.hash is changed', async () => {
      let p = path.join(fixtures, 'pages', 'webview-did-navigate-in-page-with-hash.html')
      p = p.replace(/\\/g, '/')
      const pageUrl = url.format({
        protocol: 'file',
        slashes: true,
        pathname: p
      })
      loadWebView(webview, {src: pageUrl})
      const event = await waitForEvent(webview, 'did-navigate-in-page')
      assert.equal(event.url, `${pageUrl}#test`)
    })
  })

  describe('close event', () => {
    it('should fire when interior page calls window.close', async () => {
      loadWebView(webview, {src: `file://${fixtures}/pages/close.html`})
      await waitForEvent(webview, 'close')
    })
  })

  describe('setDevToolsWebContents() API', () => {
    it('sets webContents of webview as devtools', async () => {
      const webview2 = new WebView()
      loadWebView(webview2)
      await waitForEvent(webview2, 'did-attach')

      // Setup an event handler for further usage.
      const waitForDomReady = waitForEvent(webview2, 'dom-ready')

      loadWebView(webview, {src: 'about:blank'})
      await waitForEvent(webview, 'dom-ready')
      webview.getWebContents().setDevToolsWebContents(webview2.getWebContents())
      webview.getWebContents().openDevTools()

      await waitForDomReady

      // Its WebContents should be a DevTools.
      const devtools = webview2.getWebContents()
      assert.ok(devtools.getURL().startsWith('chrome-devtools://devtools'))

      return new Promise((resolve) => {
        devtools.executeJavaScript('InspectorFrontendHost.constructor.name', (name) => {
          document.body.removeChild(webview2)
          expect(name).to.be.equal('InspectorFrontendHostImpl')
          resolve()
        })
      })
    })
  })

  describe('devtools-opened event', () => {
    it('should fire when webview.openDevTools() is called', async () => {
      loadWebView(webview, {
        src: `file://${fixtures}/pages/base-page.html`
      })
      await waitForEvent(webview, 'dom-ready')

      webview.openDevTools()
      await waitForEvent(webview, 'devtools-opened')

      webview.closeDevTools()
    })
  })

  describe('devtools-closed event', () => {
    it('should fire when webview.closeDevTools() is called', async () => {
      loadWebView(webview, {
        src: `file://${fixtures}/pages/base-page.html`
      })
      await waitForEvent(webview, 'dom-ready')

      webview.openDevTools()
      await waitForEvent(webview, 'devtools-opened')

      webview.closeDevTools()
      await waitForEvent(webview, 'devtools-closed')
    })
  })

  describe('devtools-focused event', () => {
    it('should fire when webview.openDevTools() is called', async () => {
      loadWebView(webview, {
        src: `file://${fixtures}/pages/base-page.html`
      })

      const waitForDevToolsFocused = waitForEvent(webview, 'devtools-focused')

      await waitForEvent(webview, 'dom-ready')
      webview.openDevTools()

      await waitForDevToolsFocused
      webview.closeDevTools()
    })
  })

  describe('<webview>.reload()', () => {
    it('should emit beforeunload handler', async () => {
      await loadWebView(webview, {
        nodeintegration: 'on',
        src: `file://${fixtures}/pages/beforeunload-false.html`
      })

      // Event handler has to be added before reload.
      const waitForOnbeforeunload = waitForEvent(webview, 'ipc-message')

      webview.reload()

      const {channel} = await waitForOnbeforeunload
      assert.equal(channel, 'onbeforeunload')
    })
  })

  describe('<webview>.goForward()', () => {
    it('should work after a replaced history entry', (done) => {
      let loadCount = 1
      const listener = (e) => {
        if (loadCount === 1) {
          assert.equal(e.channel, 'history')
          assert.equal(e.args[0], 1)
          assert(!webview.canGoBack())
          assert(!webview.canGoForward())
        } else if (loadCount === 2) {
          assert.equal(e.channel, 'history')
          assert.equal(e.args[0], 2)
          assert(!webview.canGoBack())
          assert(webview.canGoForward())
          webview.removeEventListener('ipc-message', listener)
        }
      }

      const loadListener = () => {
        if (loadCount === 1) {
          webview.src = `file://${fixtures}/pages/base-page.html`
        } else if (loadCount === 2) {
          assert(webview.canGoBack())
          assert(!webview.canGoForward())

          webview.goBack()
        } else if (loadCount === 3) {
          webview.goForward()
        } else if (loadCount === 4) {
          assert(webview.canGoBack())
          assert(!webview.canGoForward())

          webview.removeEventListener('did-finish-load', loadListener)
          done()
        }

        loadCount += 1
      }

      webview.addEventListener('ipc-message', listener)
      webview.addEventListener('did-finish-load', loadListener)

      loadWebView(webview, {
        nodeintegration: 'on',
        src: `file://${fixtures}/pages/history-replace.html`
      })
    })
  })

  describe('<webview>.clearHistory()', () => {
    it('should clear the navigation history', async () => {
      loadWebView(webview, {
        nodeintegration: 'on',
        src: `file://${fixtures}/pages/history.html`
      })
      const event = await waitForEvent(webview, 'ipc-message')

      assert.equal(event.channel, 'history')
      assert.equal(event.args[0], 2)
      assert(webview.canGoBack())

      webview.clearHistory()
      assert(!webview.canGoBack())
    })
  })

  describe('basic auth', () => {
    const auth = require('basic-auth')

    it('should authenticate with correct credentials', (done) => {
      const message = 'Authenticated'
      const server = http.createServer((req, res) => {
        const credentials = auth(req)
        if (credentials.name === 'test' && credentials.pass === 'test') {
          res.end(message)
        } else {
          res.end('failed')
        }
        server.close()
      })
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port
        webview.addEventListener('ipc-message', (e) => {
          assert.equal(e.channel, message)
          done()
        })
        loadWebView(webview, {
          nodeintegration: 'on',
          src: `file://${fixtures}/pages/basic-auth.html?port=${port}`
        })
      })
    })
  })

  describe('dom-ready event', () => {
    it('emits when document is loaded', (done) => {
      const server = http.createServer(() => {})
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port
        webview.addEventListener('dom-ready', () => {
          done()
        })
        loadWebView(webview, {
          src: `file://${fixtures}/pages/dom-ready.html?port=${port}`
        })
      })
    })

    it('throws a custom error when an API method is called before the event is emitted', () => {
      const expectedErrorMessage =
          'Cannot call stop because the webContents is unavailable. ' +
          'The WebView must be attached to the DOM ' +
          'and the dom-ready event emitted before this method can be called.'
      expect(() => { webview.stop() }).to.throw(expectedErrorMessage)
    })
  })

  describe('executeJavaScript', () => {
    it('should support user gesture', async () => {
      await loadWebView(webview, {
        src: `file://${fixtures}/pages/fullscreen.html`
      })

      // Event handler has to be added before js execution.
      const waitForEnterHtmlFullScreen = waitForEvent(webview, 'enter-html-full-screen')

      const jsScript = "document.querySelector('video').webkitRequestFullscreen()"
      webview.executeJavaScript(jsScript, true)

      return waitForEnterHtmlFullScreen
    })

    it('can return the result of the executed script', async () => {
      await loadWebView(webview, {
        src: 'about:blank'
      })

      const jsScript = "'4'+2"
      const expectedResult = '42'

      return new Promise((resolve) => {
        webview.executeJavaScript(jsScript, false, (result) => {
          assert.equal(result, expectedResult)
          resolve()
        })
      })
    })
  })

  describe('sendInputEvent', () => {
    it('can send keyboard event', async () => {
      loadWebView(webview, {
        nodeintegration: 'on',
        src: `file://${fixtures}/pages/onkeyup.html`
      })
      await waitForEvent(webview, 'dom-ready')

      const waitForIpcMessage = waitForEvent(webview, 'ipc-message')
      webview.sendInputEvent({
        type: 'keyup',
        keyCode: 'c',
        modifiers: ['shift']
      })

      const event = await waitForIpcMessage
      assert.equal(event.channel, 'keyup')
      assert.deepEqual(event.args, ['C', 'KeyC', 67, true, false])
    })

    it('can send mouse event', async () => {
      loadWebView(webview, {
        nodeintegration: 'on',
        src: `file://${fixtures}/pages/onmouseup.html`
      })
      await waitForEvent(webview, 'dom-ready')

      const waitForIpcMessage = waitForEvent(webview, 'ipc-message')
      webview.sendInputEvent({
        type: 'mouseup',
        modifiers: ['ctrl'],
        x: 10,
        y: 20
      })

      const event = await waitForIpcMessage
      assert.equal(event.channel, 'mouseup')
      assert.deepEqual(event.args, [10, 20, false, true])
    })
  })

  describe('media-started-playing media-paused events', () => {
    it('emits when audio starts and stops playing', async () => {
      loadWebView(webview, {src: `file://${fixtures}/pages/audio.html`})
      await waitForEvent(webview, 'media-started-playing')
      await waitForEvent(webview, 'media-paused')
    })
  })

  describe('found-in-page event', () => {
    it('emits when a request is made', (done) => {
      let requestId = null
      let activeMatchOrdinal = []
      const listener = (e) => {
        assert.equal(e.result.requestId, requestId)
        assert.equal(e.result.matches, 3)
        activeMatchOrdinal.push(e.result.activeMatchOrdinal)
        if (e.result.activeMatchOrdinal === e.result.matches) {
          assert.deepEqual(activeMatchOrdinal, [1, 2, 3])
          webview.stopFindInPage('clearSelection')
          done()
        } else {
          listener2()
        }
      }
      const listener2 = () => {
        requestId = webview.findInPage('virtual')
      }
      webview.addEventListener('found-in-page', listener)
      webview.addEventListener('did-finish-load', listener2)
      webview.src = `file://${fixtures}/pages/content.html`
      document.body.appendChild(webview)
      // TODO(deepak1556): With https://codereview.chromium.org/2836973002
      // focus of the webContents is required when triggering the api.
      // Remove this workaround after determining the cause for
      // incorrect focus.
      webview.focus()
    })
  })

  describe('did-change-theme-color event', () => {
    it('emits when theme color changes', async () => {
      loadWebView(webview, {
        src: `file://${fixtures}/pages/theme-color.html`
      })
      await waitForEvent(webview, 'did-change-theme-color')
    })
  })

  describe('permission-request event', () => {
    function setUpRequestHandler (webview, requestedPermission, completed) {
      assert.ok(webview.partition)

      const listener = function (webContents, permission, callback) {
        if (webContents.getId() === webview.getId()) {
          // requestMIDIAccess with sysex requests both midi and midiSysex so
          // grant the first midi one and then reject the midiSysex one
          if (requestedPermission === 'midiSysex' && permission === 'midi') {
            return callback(true)
          }

          assert.equal(permission, requestedPermission)
          callback(false)
          if (completed) completed()
        }
      }
      session.fromPartition(webview.partition).setPermissionRequestHandler(listener)
    }

    it('emits when using navigator.getUserMedia api', (done) => {
      if (isCI) return done()

      webview.addEventListener('ipc-message', (e) => {
        assert.equal(e.channel, 'message')
        assert.deepEqual(e.args, ['PermissionDeniedError'])
        done()
      })
      webview.src = `file://${fixtures}/pages/permissions/media.html`
      webview.partition = 'permissionTest'
      webview.setAttribute('nodeintegration', 'on')
      setUpRequestHandler(webview, 'media')
      document.body.appendChild(webview)
    })

    it('emits when using navigator.geolocation api', (done) => {
      webview.addEventListener('ipc-message', (e) => {
        assert.equal(e.channel, 'message')
        assert.deepEqual(e.args, ['User denied Geolocation'])
        done()
      })
      webview.src = `file://${fixtures}/pages/permissions/geolocation.html`
      webview.partition = 'permissionTest'
      webview.setAttribute('nodeintegration', 'on')
      setUpRequestHandler(webview, 'geolocation')
      document.body.appendChild(webview)
    })

    it('emits when using navigator.requestMIDIAccess without sysex api', (done) => {
      webview.addEventListener('ipc-message', (e) => {
        assert.equal(e.channel, 'message')
        assert.deepEqual(e.args, ['SecurityError'])
        done()
      })
      webview.src = `file://${fixtures}/pages/permissions/midi.html`
      webview.partition = 'permissionTest'
      webview.setAttribute('nodeintegration', 'on')
      setUpRequestHandler(webview, 'midi')
      document.body.appendChild(webview)
    })

    it('emits when using navigator.requestMIDIAccess with sysex api', (done) => {
      webview.addEventListener('ipc-message', (e) => {
        assert.equal(e.channel, 'message')
        assert.deepEqual(e.args, ['SecurityError'])
        done()
      })
      webview.src = `file://${fixtures}/pages/permissions/midi-sysex.html`
      webview.partition = 'permissionTest'
      webview.setAttribute('nodeintegration', 'on')
      setUpRequestHandler(webview, 'midiSysex')
      document.body.appendChild(webview)
    })

    it('emits when accessing external protocol', (done) => {
      webview.src = 'magnet:test'
      webview.partition = 'permissionTest'
      setUpRequestHandler(webview, 'openExternal', done)
      document.body.appendChild(webview)
    })

    it('emits when using Notification.requestPermission', (done) => {
      webview.addEventListener('ipc-message', (e) => {
        assert.equal(e.channel, 'message')
        assert.deepEqual(e.args, ['granted'])
        done()
      })
      webview.src = `file://${fixtures}/pages/permissions/notification.html`
      webview.partition = 'permissionTest'
      webview.setAttribute('nodeintegration', 'on')
      session.fromPartition(webview.partition).setPermissionRequestHandler((webContents, permission, callback) => {
        if (webContents.getId() === webview.getId()) {
          assert.equal(permission, 'notifications')
          setTimeout(() => { callback(true) }, 10)
        }
      })
      document.body.appendChild(webview)
    })
  })

  describe('<webview>.getWebContents', () => {
    it('can return the webcontents associated', async () => {
      const src = 'about:blank'
      await loadWebView(webview, {src})

      const webviewContents = webview.getWebContents()
      assert(webviewContents)
      assert.equal(webviewContents.getURL(), src)
    })
  })

  describe('did-get-response-details event (deprecated)', () => {
    it('emits for the page and its resources', (done) => {
      // expected {fileName: resourceType} pairs
      const expectedResources = {
        'did-get-response-details.html': 'mainFrame',
        'logo.png': 'image'
      }
      let responses = 0
      webview.addEventListener('-did-get-response-details', (event) => {
        responses += 1
        const fileName = event.newURL.slice(event.newURL.lastIndexOf('/') + 1)
        const expectedType = expectedResources[fileName]
        assert(!!expectedType, `Unexpected response details for ${event.newURL}`)
        assert(typeof event.status === 'boolean', 'status should be boolean')
        assert.equal(event.httpResponseCode, 200)
        assert.equal(event.requestMethod, 'GET')
        assert(typeof event.referrer === 'string', 'referrer should be string')
        assert(!!event.headers, 'headers should be present')
        assert(typeof event.headers === 'object', 'headers should be object')
        assert.equal(event.resourceType, expectedType, 'Incorrect resourceType')
        if (responses === Object.keys(expectedResources).length) done()
      })
      webview.src = `file://${path.join(fixtures, 'pages', 'did-get-response-details.html')}`
      document.body.appendChild(webview)
    })
  })

  describe('document.visibilityState/hidden', () => {
    afterEach(() => {
      ipcMain.removeAllListeners('pong')
    })

    it('updates when the window is shown after the ready-to-show event', async () => {
      await openTheWindow({ show: false })
      w.loadURL(`file://${fixtures}/pages/webview-visibilitychange.html`)

      await waitForOnce(w, 'ready-to-show')
      w.show()

      const [, visibilityState, hidden] = await waitForOnce(ipcMain, 'pong')
      assert(!hidden)
      assert.equal(visibilityState, 'visible')
    })

    it('inherits the parent window visibility state and receives visibilitychange events', async () => {
      await openTheWindow({ show: false })
      w.loadURL(`file://${fixtures}/pages/webview-visibilitychange.html`)

      let [, visibilityState, hidden] = await waitForOnce(ipcMain, 'pong')
      assert.equal(visibilityState, 'hidden')
      assert.equal(hidden, true)

      // We have to start waiting for the event
      // before we ask the webContents to resize.
      let getResponse = waitForOnce(ipcMain, 'pong')
      w.webContents.emit('-window-visibility-change', 'visible')

      return getResponse.then(([, visibilityState, hidden]) => {
        assert.equal(visibilityState, 'visible')
        assert.equal(hidden, false)
      })
    })
  })

  describe('will-attach-webview event', () => {
    it('supports changing the web preferences', async () => {
      ipcRenderer.send('disable-node-on-next-will-attach-webview')
      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        nodeintegration: 'yes',
        src: `file://${fixtures}/pages/a.html`
      })

      assert.equal(message,
          '{"require":"undefined","module":"undefined","process":"undefined","global":"undefined"}')
    })

    it('supports preventing a webview from being created', async () => {
      ipcRenderer.send('prevent-next-will-attach-webview')

      loadWebView(webview, {
        src: `file://${fixtures}/pages/c.html`
      })
      await waitForEvent(webview, 'destroyed')
    })

    it('supports removing the preload script', async () => {
      ipcRenderer.send('disable-preload-on-next-will-attach-webview')

      const {message} = await startLoadingWebViewAndWaitForMessage(webview, {
        nodeintegration: 'yes',
        preload: path.join(fixtures, 'module', 'preload-set-global.js'),
        src: `file://${fixtures}/pages/a.html`
      })

      assert.equal(message, 'undefined')
    })
  })

  describe('did-attach-webview event', () => {
    it('is emitted when a webview has been attached', async () => {
      await openTheWindow({ show: false })
      w.loadURL(`file://${fixtures}/pages/webview-did-attach-event.html`)

      const [, webContents] = await waitForOnce(w.webContents, 'did-attach-webview')
      const [, id] = await waitForOnce(ipcMain, 'webview-dom-ready')
      expect(webContents.id).to.equal(id)
    })
  })

  it('loads devtools extensions registered on the parent window', async () => {
    await openTheWindow({ show: false })
    BrowserWindow.removeDevToolsExtension('foo')

    const extensionPath = path.join(__dirname, 'fixtures', 'devtools-extensions', 'foo')
    BrowserWindow.addDevToolsExtension(extensionPath)

    w.loadURL(`file://${fixtures}/pages/webview-devtools.html`)

    const [, {runtimeId, tabId}] = await waitForOnce(ipcMain, 'answer')
    expect(runtimeId).to.equal('foo')
    expect(tabId).to.be.not.equal(w.webContents.id)
  })

  describe('guestinstance attribute', () => {
    it('before loading there is no attribute', () => {
      loadWebView(webview)  // Don't wait for loading to finish.
      assert(!webview.hasAttribute('guestinstance'))
    })

    it('loading a page sets the guest view', async () => {
      await loadWebView(webview, {
        src: `file://${fixtures}/api/blank.html`
      })

      const instance = webview.getAttribute('guestinstance')
      assert.equal(instance, parseInt(instance))

      const guest = getGuestWebContents(parseInt(instance))
      assert.equal(guest, webview.getWebContents())
    })

    it('deleting the attribute destroys the webview', async () => {
      await loadWebView(webview, {
        src: `file://${fixtures}/api/blank.html`
      })

      const instance = parseInt(webview.getAttribute('guestinstance'))
      const waitForDestroy = waitForEvent(webview, 'destroyed')
      webview.removeAttribute('guestinstance')

      await waitForDestroy
      assert.equal(getGuestWebContents(instance), null)
    })

    it('setting the attribute on a new webview moves the contents', (done) => {
      const loadListener = () => {
        const webContents = webview.getWebContents()
        const instance = webview.getAttribute('guestinstance')

        const destroyListener = () => {
          assert.equal(webContents, webview2.getWebContents())

          // Make sure that events are hooked up to the right webview now
          webview2.addEventListener('console-message', (e) => {
            assert.equal(e.message, 'a')
            document.body.removeChild(webview2)
            done()
          })

          webview2.src = `file://${fixtures}/pages/a.html`
        }
        webview.addEventListener('destroyed', destroyListener, {once: true})

        const webview2 = new WebView()
        loadWebView(webview2, {
          guestinstance: instance
        })
      }
      webview.addEventListener('did-finish-load', loadListener, {once: true})
      loadWebView(webview, {
        src: `file://${fixtures}/api/blank.html`
      })
    })

    it('setting the attribute to an invalid guestinstance does nothing', async () => {
      await loadWebView(webview, {
        src: `file://${fixtures}/api/blank.html`
      })
      webview.setAttribute('guestinstance', 55)

      // Make sure that events are still hooked up to the webview
      const waitForMessage = waitForEvent(webview, 'console-message')
      webview.src = `file://${fixtures}/pages/a.html`
      const {message} = await waitForMessage
      assert.equal(message, 'a')
    })

    it('setting the attribute on an existing webview moves the contents', (done) => {
      const load1Listener = () => {
        const webContents = webview.getWebContents()
        const instance = webview.getAttribute('guestinstance')
        let destroyedInstance

        const destroyListener = () => {
          assert.equal(webContents, webview2.getWebContents())
          assert.equal(null, getGuestWebContents(parseInt(destroyedInstance)))

          // Make sure that events are hooked up to the right webview now
          webview2.addEventListener('console-message', (e) => {
            assert.equal(e.message, 'a')
            document.body.removeChild(webview2)
            done()
          })

          webview2.src = 'file://' + fixtures + '/pages/a.html'
        }
        webview.addEventListener('destroyed', destroyListener, {once: true})

        const webview2 = new WebView()
        const load2Listener = () => {
          destroyedInstance = webview2.getAttribute('guestinstance')
          assert.notEqual(instance, destroyedInstance)

          webview2.setAttribute('guestinstance', instance)
        }
        webview2.addEventListener('did-finish-load', load2Listener, {once: true})
        loadWebView(webview2, {
          src: `file://${fixtures}/api/blank.html`
        })
      }

      webview.addEventListener('did-finish-load', load1Listener, {once: true})
      loadWebView(webview, {
        src: `file://${fixtures}/api/blank.html`
      })
    })

    it('moving a guest back to its original webview should work', (done) => {
      const loadListener = () => {
        const webContents = webview.getWebContents()
        const instance = webview.getAttribute('guestinstance')

        const destroy1Listener = () => {
          assert.equal(webContents, webview2.getWebContents())
          assert.equal(null, webview.getWebContents())

          const destroy2Listener = () => {
            assert.equal(webContents, webview.getWebContents())
            assert.equal(null, webview2.getWebContents())

            // Make sure that events are hooked up to the right webview now
            webview.addEventListener('console-message', (e) => {
              document.body.removeChild(webview2)
              assert.equal(e.message, 'a')
              done()
            })

            webview.src = `file://${fixtures}/pages/a.html`
          }
          webview2.addEventListener('destroyed', destroy2Listener, {once: true})
          webview.setAttribute('guestinstance', instance)
        }
        webview.addEventListener('destroyed', destroy1Listener, {once: true})

        const webview2 = new WebView()
        webview2.setAttribute('guestinstance', instance)
        document.body.appendChild(webview2)
      }

      webview.addEventListener('did-finish-load', loadListener, {once: true})
      loadWebView(webview, {
        src: `file://${fixtures}/api/blank.html`
      })
    })

    it('setting the attribute on a webview in a different window moves the contents', (done) => {
      const loadListener = () => {
        const instance = webview.getAttribute('guestinstance')

        w = new BrowserWindow({ show: false })
        w.webContents.once('did-finish-load', () => {
          ipcMain.once('pong', () => {
            assert(!webview.hasAttribute('guestinstance'))
            done()
          })

          w.webContents.send('guestinstance', instance)
        })
        w.loadURL(`file://${fixtures}/pages/webview-move-to-window.html`)
      }
      webview.addEventListener('did-finish-load', loadListener, {once: true})
      webview.src = `file://${fixtures}/api/blank.html`
      document.body.appendChild(webview)
    })

    it('does not delete the guestinstance attribute when moving the webview to another parent node', (done) => {
      webview.addEventListener('dom-ready', function domReadyListener () {
        webview.addEventListener('did-attach', () => {
          assert(webview.guestinstance != null)
          assert(webview.getWebContents() != null)
          done()
        })

        document.body.replaceChild(webview, div)
      })
      webview.src = `file://${fixtures}/pages/a.html`

      const div = document.createElement('div')
      div.appendChild(webview)
      document.body.appendChild(div)
    })

    it('does not destroy the webContents when hiding/showing the webview (regression)', (done) => {
      webview.addEventListener('dom-ready', function domReadyListener () {
        const instance = webview.getAttribute('guestinstance')
        assert(instance != null)

        // Wait for event directly since attach happens asynchronously over IPC
        ipcMain.once('ELECTRON_GUEST_VIEW_MANAGER_ATTACH_GUEST', () => {
          assert(webview.getWebContents() != null)
          assert.equal(instance, webview.getAttribute('guestinstance'))
          done()
        })

        webview.style.display = 'none'
        webview.offsetHeight // eslint-disable-line
        webview.style.display = 'block'
      })
      webview.src = `file://${fixtures}/pages/a.html`
      document.body.appendChild(webview)
    })

    it('does not reload the webContents when hiding/showing the webview (regression)', (done) => {
      webview.addEventListener('dom-ready', function domReadyListener () {
        webview.addEventListener('did-start-loading', () => {
          done(new Error('webview started loading unexpectedly'))
        })

        // Wait for event directly since attach happens asynchronously over IPC
        webview.addEventListener('did-attach', () => {
          done()
        })

        webview.style.display = 'none'
        webview.offsetHeight  // eslint-disable-line
        webview.style.display = 'block'
      })
      webview.src = `file://${fixtures}/pages/a.html`
      document.body.appendChild(webview)
    })
  })

  describe('DOM events', () => {
    let div

    beforeEach(() => {
      div = document.createElement('div')
      div.style.width = '100px'
      div.style.height = '10px'
      div.style.overflow = 'hidden'
      webview.style.height = '100%'
      webview.style.width = '100%'
    })

    afterEach(() => {
      if (div != null) div.remove()
    })

    it('emits resize events', (done) => {
      webview.addEventListener('dom-ready', () => {
        div.style.width = '1234px'
        div.style.height = '789px'
      })

      webview.addEventListener('resize', function onResize (event) {
        webview.removeEventListener('resize', onResize)
        assert.equal(event.newWidth, 100)
        assert.equal(event.newHeight, 10)
        assert.equal(event.target, webview)
        webview.addEventListener('resize', function onResizeAgain (event) {
          // This will be triggered after setting the new div width and height.
          webview.removeEventListener('resize', onResizeAgain)
          assert.equal(event.newWidth, 1234)
          assert.equal(event.newHeight, 789)
          assert.equal(event.target, webview)
          done()
        })
      })

      webview.src = `file://${fixtures}/pages/a.html`
      div.appendChild(webview)
      document.body.appendChild(div)
    })
  })

  describe('disableguestresize attribute', () => {
    it('does not have attribute by default', () => {
      document.body.appendChild(webview)
      assert(!webview.hasAttribute('disableguestresize'))
    })

    it('resizes guest when attribute is not present', async () => {
      const INITIAL_SIZE = 200
      await openTheWindow({show: false, width: INITIAL_SIZE, height: INITIAL_SIZE})
      w.loadURL(`file://${fixtures}/pages/webview-guest-resize.html`)
      await waitForOnce(ipcMain, 'webview-loaded')

      const elementResize = waitForOnce(ipcMain, 'webview-element-resize')
          .then(([event, width, height]) => {
            assert.equal(width, CONTENT_SIZE)
            assert.equal(height, CONTENT_SIZE)
          })

      const guestResize = waitForOnce(ipcMain, 'webview-guest-resize')
          .then(([, width, height]) => {
            assert.equal(width, CONTENT_SIZE)
            assert.equal(height, CONTENT_SIZE)
          })

      const CONTENT_SIZE = 300
      assert(CONTENT_SIZE !== INITIAL_SIZE)
      w.setContentSize(CONTENT_SIZE, CONTENT_SIZE)

      return Promise.all([elementResize, guestResize])
    })

    it('does not resize guest when attribute is present', async () => {
      const INITIAL_SIZE = 200
      await openTheWindow({show: false, width: INITIAL_SIZE, height: INITIAL_SIZE})
      w.loadURL(`file://${fixtures}/pages/webview-no-guest-resize.html`)
      await waitForOnce(ipcMain, 'webview-loaded')

      const noGuestResizePromise = Promise.race([
        waitForOnce(ipcMain, 'webview-guest-resize'),
        new Promise(resolve => setTimeout(() => resolve(), 500))
      ]).then((eventData = null) => {
        if (eventData !== null) {
          // Means we got the 'webview-guest-resize' event before the time out.
          return Promise.reject(new Error('Unexpected guest resize message'))
        }
      })

      const CONTENT_SIZE = 300
      assert(CONTENT_SIZE !== INITIAL_SIZE)
      w.setContentSize(CONTENT_SIZE, CONTENT_SIZE)

      return noGuestResizePromise
    })

    it('dispatches element resize event even when attribute is present', async () => {
      const INITIAL_SIZE = 200
      await openTheWindow({show: false, width: INITIAL_SIZE, height: INITIAL_SIZE})
      w.loadURL(`file://${fixtures}/pages/webview-no-guest-resize.html`)
      await waitForOnce(ipcMain, 'webview-loaded')

      const elementResizePromise = waitForOnce(ipcMain, 'webview-element-resize')
          .then(([, width, height]) => {
            expect(width).to.equal(CONTENT_SIZE)
            expect(height).to.equal(CONTENT_SIZE)
          })

      const CONTENT_SIZE = 300
      assert(CONTENT_SIZE !== INITIAL_SIZE)
      w.setContentSize(CONTENT_SIZE, CONTENT_SIZE)

      return elementResizePromise
    })

    it('can be manually resized with setSize even when attribute is present', async () => {
      const INITIAL_SIZE = 200
      await openTheWindow({show: false, width: INITIAL_SIZE, height: INITIAL_SIZE})
      w.loadURL(`file://${fixtures}/pages/webview-no-guest-resize.html`)
      await waitForOnce(ipcMain, 'webview-loaded')

      const GUEST_WIDTH = 10
      const GUEST_HEIGHT = 20

      const guestResizePromise = waitForOnce(ipcMain, 'webview-guest-resize')
          .then(([event, width, height]) => {
            expect(width).to.be.equal(GUEST_WIDTH)
            expect(height).to.be.equal(GUEST_HEIGHT)
          })

      const wc = webContents.getAllWebContents().find((wc) => {
        return wc.hostWebContents &&
            wc.hostWebContents.id === w.webContents.id
      })
      assert(wc)
      wc.setSize({
        normal: {
          width: GUEST_WIDTH,
          height: GUEST_HEIGHT
        }
      })

      return guestResizePromise
    })
  })

  describe('zoom behavior', () => {
    const zoomScheme = remote.getGlobal('zoomScheme')
    const webviewSession = session.fromPartition('webview-temp')

    before((done) => {
      const protocol = webviewSession.protocol
      protocol.registerStringProtocol(zoomScheme, (request, callback) => {
        callback('hello')
      }, (error) => done(error))
    })

    after((done) => {
      const protocol = webviewSession.protocol
      protocol.unregisterProtocol(zoomScheme, (error) => done(error))
    })

    it('inherits the zoomFactor of the parent window', async () => {
      await openTheWindow({
        show: false,
        webPreferences: {
          zoomFactor: 1.2
        }
      })
      w.loadURL(`file://${fixtures}/pages/webview-zoom-factor.html`)

      const [, zoomFactor, zoomLevel] = await waitForOnce(ipcMain, 'webview-parent-zoom-level')
      expect(zoomFactor).to.equal(1.2)
      expect(zoomLevel).to.equal(1)
    })

    it('maintains zoom level on navigation', async () => {
      return openTheWindow({
        show: false,
        webPreferences: {
          zoomFactor: 1.2
        }
      }).then(() => {
        const promise = new Promise((resolve) => {
          ipcMain.on('webview-zoom-level', (event, zoomLevel, zoomFactor, newHost, final) => {
            if (!newHost) {
              expect(zoomFactor).to.equal(1.44)
              expect(zoomLevel).to.equal(2.0)
            } else {
              expect(zoomFactor).to.equal(1.2)
              expect(zoomLevel).to.equal(1)
            }

            if (final) {
              resolve()
            }
          })
        })

        w.loadURL(`file://${fixtures}/pages/webview-custom-zoom-level.html`)

        return promise
      })
    })

    it('maintains zoom level when navigating within same page', async () => {
      return openTheWindow({
        show: false,
        webPreferences: {
          zoomFactor: 1.2
        }
      }).then(() => {
        const promise = new Promise((resolve) => {
          ipcMain.on('webview-zoom-in-page', (event, zoomLevel, zoomFactor, final) => {
            expect(zoomFactor).to.equal(1.44)
            expect(zoomLevel).to.equal(2.0)

            if (final) {
              resolve()
            }
          })
        })

        w.loadURL(`file://${fixtures}/pages/webview-in-page-navigate.html`)

        return promise
      })
    })

    it('inherits zoom level for the origin when available', async () => {
      await openTheWindow({
        show: false,
        webPreferences: {
          zoomFactor: 1.2
        }
      })
      w.loadURL(`file://${fixtures}/pages/webview-origin-zoom-level.html`)

      const [, zoomLevel] = await waitForOnce(ipcMain, 'webview-origin-zoom-level')
      expect(zoomLevel).to.equal(2.0)
    })
  })

  describe('nativeWindowOpen option', () => {
    beforeEach(() => {
      webview.setAttribute('allowpopups', 'on')
      webview.setAttribute('nodeintegration', 'on')
      webview.setAttribute('webpreferences', 'nativeWindowOpen=1')
    })

    it('opens window of about:blank with cross-scripting enabled', async () => {
      // Don't wait for loading to finish.
      loadWebView(webview, {
        src: `file://${path.join(fixtures, 'api', 'native-window-open-blank.html')}`
      })

      const [, content] = await waitForOnce(ipcMain, 'answer')
      expect(content).to.equal('Hello')
    })

    it('opens window of same domain with cross-scripting enabled', async () => {
      // Don't wait for loading to finish.
      loadWebView(webview, {
        src: `file://${path.join(fixtures, 'api', 'native-window-open-file.html')}`
      })

      const [, content] = await waitForOnce(ipcMain, 'answer')
      expect(content).to.equal('Hello')
    })

    it('returns null from window.open when allowpopups is not set', async () => {
      webview.removeAttribute('allowpopups')

      // Don't wait for loading to finish.
      loadWebView(webview, {
        src: `file://${path.join(fixtures, 'api', 'native-window-open-no-allowpopups.html')}`
      })

      const [, {windowOpenReturnedNull}] = await waitForOnce(ipcMain, 'answer')
      expect(windowOpenReturnedNull).to.equal(true)
    })

    it('blocks accessing cross-origin frames', async () => {
      // Don't wait for loading to finish.
      loadWebView(webview, {
        src: `file://${path.join(fixtures, 'api', 'native-window-open-cross-origin.html')}`
      })

      const [, content] = await waitForOnce(ipcMain, 'answer')
      const expectedContent =
          'Blocked a frame with origin "file://" from accessing a cross-origin frame.'

      expect(content).to.equal(expectedContent)
    })

    it('emits a new-window event', async () => {
      // Don't wait for loading to finish.
      loadWebView(webview, {
        src: `file://${fixtures}/pages/window-open.html`
      })
      const {url, frameName} = await waitForEvent(webview, 'new-window')

      expect(url).to.equal('http://host/')
      expect(frameName).to.equal('host')
    })

    it('emits a browser-window-created event', async () => {
      // Don't wait for loading to finish.
      loadWebView(webview, {
        src: `file://${fixtures}/pages/window-open.html`
      })

      await waitForOnce(app, 'browser-window-created')
    })

    it('emits a web-contents-created event', (done) => {
      app.on('web-contents-created', function listener (event, contents) {
        if (contents.getType() === 'window') {
          app.removeListener('web-contents-created', listener)
          done()
        }
      })
      loadWebView(webview, {
        src: `file://${fixtures}/pages/window-open.html`
      })
    })
  })
})
