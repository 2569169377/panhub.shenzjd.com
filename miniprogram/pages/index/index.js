const api = require('../../utils/api.js')
const auth = require('../../utils/auth.js')
const { extractMergedFromResponse } = require('../../utils/extract.js')
const { PLATFORM_INFO } = require('../../shared_platforms.js')

Page({
  data: {
    keyword: '',
    loading: false,
    searched: false,
    hasResults: false,
    error: '',
    total: 0,
    elapsedMs: 0,
    merged: {},
    platforms: [],
    filterPlatform: 'all',
    groupedResults: [],
    hotTags: [],
    // 解锁相关
    locked: false,
    showUnlock: false,
    unlockPwd: '',
    unlocking: false,
    pendingKeyword: ''
  },

  onLoad() {
    this.checkLock()
  },

  checkLock() {
    auth.fetchStatus().then(locked => {
      if (locked) {
        this.setData({ locked: true, showUnlock: true })
      } else {
        this.setData({ locked: false })
        this.loadHot()
      }
    }).catch(() => {
      // 接口异常时按未锁定处理，让搜索自行报错
      this.setData({ locked: false })
      this.loadHot()
    })
  },

  loadHot() {
    api.getHotSearches(10).then(res => {
      if (res && res.code === 0 && res.data && res.data.hotSearches) {
        this.setData({ hotTags: res.data.hotSearches.map(s => s.term).filter(Boolean) })
      }
    }).catch(() => {})
  },

  onKeywordChange(e) {
    this.setData({ keyword: e.detail.value })
  },

  onClear() {
    this.setData({
      keyword: '',
      searched: false,
      hasResults: false,
      merged: {},
      total: 0,
      error: '',
      groupedResults: [],
      platforms: [],
      filterPlatform: 'all'
    })
  },

  onQuickSearch(e) {
    const term = e.currentTarget.dataset.term
    this.setData({ keyword: term })
    this.doSearch(term)
  },

  onSearch() {
    this.doSearch(this.data.keyword)
  },

  doSearch(keyword) {
    const kw = (keyword || '').trim()
    if (!kw || this.data.loading) return
    if (this.data.locked) {
      this.setData({ pendingKeyword: kw, showUnlock: true })
      return
    }
    api.recordHotSearch(kw).catch(() => {})
    this.setData({ loading: true, searched: true, error: '', hasResults: false, filterPlatform: 'all' })
    this.showMessage('loading', '搜索中…')

    const start = Date.now()
    api.search(kw)
      .then(res => {
        const data = (res && res.data) || res
        const merged = extractMergedFromResponse(data)
        const platforms = Object.keys(merged).filter(t => merged[t] && merged[t].length > 0)
        const total = Object.values(merged).reduce((s, a) => s + (a ? a.length : 0), 0)
        this.setData({
          merged,
          platforms,
          total,
          elapsedMs: Date.now() - start,
          loading: false,
          hasResults: total > 0
        })
        this._refreshGroupedResults()
        if (total === 0) this.showMessage('info', '未找到相关资源')
      })
      .catch(err => {
        const msg = (err && err.message) || '请求失败'
        this.setData({ loading: false, error: msg, hasResults: false })
        if (err && err.statusCode === 401) {
          // 凭证失效，重新弹解锁
          this.setData({ locked: true, showUnlock: true })
        }
        this.showMessage('error', msg)
      })
  },

  setFilter(e) {
    this.setData({ filterPlatform: e.currentTarget.dataset.p }, () => {
      this._refreshGroupedResults()
    })
  },

  _refreshGroupedResults() {
    const { merged, filterPlatform } = this.data
    const source = filterPlatform === 'all'
      ? merged
      : { [filterPlatform]: merged[filterPlatform] || [] }
    const list = []
    for (const type of Object.keys(source)) {
      const items = source[type]
      if (!items || !items.length) continue
      list.push({ type, items })
    }
    this.setData({ groupedResults: list })
  },

  platformName(t) {
    return (PLATFORM_INFO[t] && PLATFORM_INFO[t].name) || t
  },

  platformColor(t) {
    return (PLATFORM_INFO[t] && PLATFORM_INFO[t].color) || '#9ca3af'
  },

  onUnlockInput(e) {
    this.setData({ unlockPwd: e.detail.value })
  },

  onUnlockConfirm() {
    const pwd = this.data.unlockPwd.trim()
    if (!pwd) {
      this.showMessage('error', '请输入密码')
      return
    }
    if (this.data.unlocking) return
    this.setData({ unlocking: true })
    auth.unlock(pwd).then(ok => {
      if (ok) {
        this.setData({ locked: false, showUnlock: false, unlockPwd: '', unlocking: false })
        this.loadHot()
        if (this.data.pendingKeyword) {
          const kw = this.data.pendingKeyword
          this.setData({ pendingKeyword: '' })
          this.doSearch(kw)
        }
      } else {
        this.setData({ unlocking: false })
        this.showMessage('error', '密码错误')
      }
    }).catch(() => {
      this.setData({ unlocking: false })
      this.showMessage('error', '解锁失败，请重试')
    })
  },

  onCopyLink(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.setClipboardData({
      data: url,
      success: () => this.showMessage('success', '链接已复制')
    })
  },

  showMessage(theme, message) {
    if (this.selectComponent('#t-message')) {
      this.selectComponent('#t-message').show({ theme, content: message, duration: 2000 })
    }
  }
})
