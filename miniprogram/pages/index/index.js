const api = require('../../utils/api.js')
const auth = require('../../utils/auth.js')
const { extractMergedFromResponse } = require('../../utils/extract.js')
const { PLATFORM_INFO } = require('../../shared_platforms.js')

// 设计稿覆盖平台（首页展示 5 大平台）
const PLATFORM_CHIPS = [
  { key: 'quark', name: '夸克网盘', color: '#1A94FF' },
  { key: 'aliyun', name: '阿里云盘', color: '#FF6B38' },
  { key: 'baidu', name: '百度网盘', color: '#2A5BF2' },
  { key: '115', name: '115 网盘', color: '#ED3D3D' },
  { key: 'xunlei', name: '迅雷网盘', color: '#0D87E0' }
]

// 每组默认展示条数
const DEFAULT_VISIBLE = 3

// 内联 SVG 图标（data URL，避免额外图标文件）
const svg = (body, color, stroke) =>
  'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none">' + body(color, stroke) + '</svg>'
  )

const ICONS = {
  searchWhite: svg((c, s) => '<circle cx="11" cy="11" r="7" stroke="' + c + '" stroke-width="' + s + '"/><path d="M16.5 16.5L21 21" stroke="' + c + '" stroke-width="' + s + '" stroke-linecap="round"/>', '#FFFFFF', 2.4),
  searchBrand: svg((c, s) => '<circle cx="11" cy="11" r="7" stroke="' + c + '" stroke-width="' + s + '"/><path d="M16.5 16.5L21 21" stroke="' + c + '" stroke-width="' + s + '" stroke-linecap="round"/>', '#07C160', 2.2),
  flameBrand: svg(() => '<path d="M12 21C7.6 21 4 17.9 4 13.9C4 10.5 6.9 8 8.5 6.2C9 5.7 10 5.8 10.2 6.6C10.4 7.4 10.2 8.3 10.6 9C11 8 11.6 6.7 11.5 5C11.4 4.1 12.3 3.7 13 4.3C15.5 6.6 20 9.8 20 13.9C20 17.9 16.4 21 12 21Z" fill="#07C160"/><path d="M12 21C10.1 21 8.5 19.6 8.5 17.7C8.5 16 9.7 14.7 10.8 13.5C11.1 13.1 11.8 13.2 11.9 13.8C12.1 14.5 12 15.1 12.3 15.7C12.7 14.8 13.1 13.8 13.1 12.3C13.1 11.2 14.2 10.7 14.8 11.5C15.8 12.9 16.3 14.4 16.3 15.6C16.3 18.1 14.5 21 12 21Z" fill="#06AD56"/>', '#07C160'),
  chevron: svg((c, s) => '<path d="M9 18L15 12L9 6" stroke="' + c + '" stroke-width="' + s + '" stroke-linecap="round" stroke-linejoin="round"/>', '#999999', 2.2),
  clear: svg((c, s) => '<circle cx="12" cy="12" r="10" fill="' + c + '"/><path d="M8.5 8.5L15.5 15.5M15.5 8.5L8.5 15.5" stroke="#6B7280" stroke-width="1.8" stroke-linecap="round"/>', '#E5E7EB', 1),
  lock: svg((c, s) => '<rect x="4" y="11" width="16" height="11" rx="2.5" stroke="' + c + '" stroke-width="1.8"/><path d="M8 11V7C8 4.8 9.8 3 12 3C14.2 3 16 4.8 16 7V11" stroke="' + c + '" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="16" r="1.4" fill="' + c + '"/>', '#07C160', 1)
}

Page({
  data: {
    // 自定义导航
    statusBarHeight: 20,
    navHeight: 64,
    // 搜索
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
    platformChips: PLATFORM_CHIPS,
    // 内联图标
    searchIconWhite: ICONS.searchWhite,
    searchIconBrand: ICONS.searchBrand,
    flameBrand: ICONS.flameBrand,
    chevronIcon: ICONS.chevron,
    clearIcon: ICONS.clear,
    lockIcon: ICONS.lock,
    // 结果分组展开态 { type: true }
    expanded: {},
    // 解锁
    locked: false,
    showUnlock: false,
    unlockPwd: '',
    unlocking: false,
    pendingKeyword: ''
  },

  onLoad() {
    const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({
      statusBarHeight: win.statusBarHeight || 20,
      navHeight: (win.statusBarHeight || 20) + 44
    })
    this.checkLock()
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 })
    }
    // 热搜页点词条跳回 → 自动搜索
    const kw = wx.getStorageSync('panhub_quick_kw')
    if (kw) {
      wx.removeStorageSync('panhub_quick_kw')
      this.setData({ keyword: kw })
      this.doSearch(kw)
    }
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
      this.setData({ locked: false })
      this.loadHot()
    })
  },

  loadHot() {
    api.getHotSearches(10).then(res => {
      if (res && res.code === 0 && res.data && res.data.hotSearches) {
        const tags = res.data.hotSearches.map(s => s.term).filter(Boolean)
        this.setData({ hotTags: tags.slice(0, 8) })
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
      filterPlatform: 'all',
      expanded: {}
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
    // 记录搜索历史（供设置页"清除搜索历史"）
    this._recordHistory(kw)
    this.setData({ loading: true, searched: true, error: '', hasResults: false, filterPlatform: 'all', expanded: {} })
    wx.showLoading({ title: '搜索中…', mask: true })

    const start = Date.now()
    // 应用"默认搜索平台"设置
    const src = this._defaultSrc()
    const searchParams = src ? { src } : undefined
    api.search(kw, searchParams)
      .then(res => {
        wx.hideLoading()
        const data = (res && res.data) || res
        const merged = extractMergedFromResponse(data)
        this._applySort(merged)
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
        if (total === 0) wx.showToast({ title: '未找到相关资源', icon: 'none' })
      })
      .catch(err => {
        wx.hideLoading()
        const msg = (err && err.message) || '请求失败'
        this.setData({ loading: false, error: msg, hasResults: false })
        if (err && err.statusCode === 401) {
          this.setData({ locked: true, showUnlock: true })
        }
        wx.showToast({ title: msg, icon: 'none' })
      })
  },

  setFilter(e) {
    this.setData({ filterPlatform: e.currentTarget.dataset.p, expanded: {} }, () => {
      this._refreshGroupedResults()
    })
  },

  toggleExpand(e) {
    const type = e.currentTarget.dataset.type
    this.setData({ ['expanded.' + type]: !this.data.expanded[type] })
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
      list.push({ type, items, total: items.length })
    }
    this.setData({ groupedResults: list })
  },

  // 设置：默认搜索平台 → src 参数（'全部平台' 返回空）
  _defaultSrc() {
    const v = wx.getStorageSync('panhub_src') || '全部平台'
    const map = { '夸克网盘': 'quark', '阿里云盘': 'aliyun', '百度网盘': 'baidu', '115 网盘': '115', '迅雷网盘': 'xunlei' }
    return map[v] || ''
  },

  // 设置：结果排序（最新发布/最早发布按 datetime，其余保持后端顺序）
  _applySort(merged) {
    const v = wx.getStorageSync('panhub_sort') || '默认排序'
    if (v === '默认排序') return
    const dir = v === '最新发布' ? -1 : 1
    for (const type in merged) {
      const items = merged[type]
      if (!Array.isArray(items)) continue
      items.sort((a, b) => {
        const da = a.datetime ? new Date(a.datetime).getTime() : 0
        const db = b.datetime ? new Date(b.datetime).getTime() : 0
        if (da === db) return 0
        return (da > db ? 1 : -1) * dir
      })
    }
  },

  // 记录搜索历史（最近 20 条，去重）
  _recordHistory(kw) {
    try {
      const list = wx.getStorageSync('panhub_history') || []
      const next = [kw].concat(list.filter(t => t !== kw)).slice(0, 20)
      wx.setStorageSync('panhub_history', next)
    } catch (e) {}
  },

  platformName(t) {
    return (PLATFORM_INFO[t] && PLATFORM_INFO[t].name) || t
  },

  platformColor(t) {
    return (PLATFORM_INFO[t] && PLATFORM_INFO[t].color) || '#999999'
  },

  // 结果副行：日期 · 提取码
  metaText(link) {
    const parts = []
    if (link.datetime) parts.push(link.datetime)
    if (link.password) parts.push('提取码 ' + link.password)
    return parts.join(' · ')
  },

  goHot() {
    wx.switchTab({ url: '/pages/hot/hot' })
  },

  onUnlockInput(e) {
    this.setData({ unlockPwd: e.detail.value })
  },

  onUnlockConfirm() {
    const pwd = this.data.unlockPwd.trim()
    if (!pwd) {
      wx.showToast({ title: '请输入密码', icon: 'none' })
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
        wx.showToast({ title: '密码错误', icon: 'none' })
      }
    }).catch(() => {
      this.setData({ unlocking: false })
      wx.showToast({ title: '解锁失败，请重试', icon: 'none' })
    })
  },

  onCopyLink(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '链接已复制', icon: 'success' })
    })
  }
})
