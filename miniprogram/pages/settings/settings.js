const auth = require('../../utils/auth.js')

const VERSION = 'v2.0.0'

// 内联 SVG 图标（灰 #6B7280）
const svg = (body) =>
  'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none">' + body + '</svg>'
  )

const ICONS = {
  searchWhite: svg('<circle cx="11" cy="11" r="7" stroke="#FFFFFF" stroke-width="2.4"/><path d="M16.5 16.5L21 21" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round"/>'),
  chevron: svg('<path d="M9 18L15 12L9 6" stroke="#999999" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'),
  lock: svg('<rect x="4" y="11" width="16" height="11" rx="2.5" stroke="#6B7280" stroke-width="1.8"/><path d="M8 11V7C8 4.8 9.8 3 12 3C14.2 3 16 4.8 16 7V11" stroke="#6B7280" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="16" r="1.4" fill="#6B7280"/>'),
  moon: svg('<path d="M21 12.8C20.4 17 16.8 20.2 12.5 20.2C7.8 20.2 4 16.4 4 11.7C4 7.4 7.2 3.8 11.4 3.2C8.5 5 6.6 8.1 6.6 11.6C6.6 15.7 9.9 19 14 19C16.3 19 18.4 18.2 20 16.8C20.3 16.2 20.5 16.4 21 12.8Z" fill="#6B7280"/>'),
  grid: svg('<rect x="3" y="3" width="8" height="8" rx="1.5" fill="#6B7280"/><rect x="13" y="3" width="8" height="8" rx="1.5" fill="#6B7280" opacity="0.5"/><rect x="3" y="13" width="8" height="8" rx="1.5" fill="#6B7280" opacity="0.5"/><rect x="13" y="13" width="8" height="8" rx="1.5" fill="#6B7280"/>'),
  sort: svg('<rect x="3" y="7" width="18" height="2" rx="1" fill="#6B7280"/><rect x="3" y="11" width="11" height="2" rx="1" fill="#6B7280"/><rect x="3" y="15" width="15" height="2" rx="1" fill="#6B7280"/>'),
  trash: svg('<path d="M4 7H20" stroke="#6B7280" stroke-width="1.8" stroke-linecap="round"/><path d="M9 7V5C9 4.4 9.4 4 10 4H14C14.6 4 15 4.4 15 5V7" stroke="#6B7280" stroke-width="1.8" stroke-linecap="round"/><path d="M6.5 7L7.5 20C7.5 20.6 8 21 8.6 21H15.4C16 21 16.5 20.6 16.5 20L17.5 7" stroke="#6B7280" stroke-width="1.8" stroke-linecap="round"/><path d="M10 11V17M14 11V17" stroke="#6B7280" stroke-width="1.8" stroke-linecap="round"/>'),
  info: svg('<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" fill="#6B7280"/>'),
  feedback: svg('<path d="M4 17.5L17.5 4C18.3 3.2 19.7 3.2 20.5 4C21.3 4.8 21.3 6.2 20.5 7L7 20.5H4V17.5Z" stroke="#6B7280" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 7.5L16.5 10" stroke="#6B7280" stroke-width="1.8" stroke-linecap="round"/>')
}

const SORT_OPTIONS = ['默认排序', '最新发布', '最早发布']
const THEME_OPTIONS = ['跟随系统', '浅色模式', '深色模式']

Page({
  data: {
    version: VERSION,
    unlocked: false,
    darkMode: '跟随系统',
    defaultSrc: '全部平台',
    sortType: '默认排序',
    historyCount: 0,
    // 解锁弹窗
    showUnlock: false,
    unlockPwd: '',
    unlocking: false,
    iconLock: ICONS.lock,
    iconMoon: ICONS.moon,
    iconGrid: ICONS.grid,
    iconSort: ICONS.sort,
    iconTrash: ICONS.trash,
    iconInfo: ICONS.info,
    iconFeedback: ICONS.feedback,
    searchWhite: ICONS.searchWhite,
    chevron: ICONS.chevron
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
    this.refresh()
  },

  refresh() {
    const history = wx.getStorageSync('panhub_history') || []
    this.setData({
      unlocked: !!auth.getToken(),
      darkMode: wx.getStorageSync('panhub_dark') || '跟随系统',
      defaultSrc: wx.getStorageSync('panhub_src') || '全部平台',
      sortType: wx.getStorageSync('panhub_sort') || '默认排序',
      historyCount: history.length
    })
  },

  /* ---- 搜索密码锁 ---- */
  onToggleLock(e) {
    const on = e.detail.value
    if (on) {
      // 开启 → 输入密码解锁
      this.setData({ showUnlock: true })
    } else {
      // 关闭 → 退出解锁
      auth.clearToken()
      this.setData({ unlocked: false })
      wx.showToast({ title: '已退出解锁', icon: 'none' })
    }
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
      this.setData({ unlocking: false })
      if (ok) {
        this.setData({ showUnlock: false, unlockPwd: '', unlocked: true })
        wx.showToast({ title: '解锁成功', icon: 'success' })
      } else {
        wx.showToast({ title: '密码错误', icon: 'none' })
      }
    }).catch(() => {
      this.setData({ unlocking: false })
      wx.showToast({ title: '解锁失败，请重试', icon: 'none' })
    })
  },

  onCloseUnlock() {
    this.setData({ showUnlock: false, unlockPwd: '' })
  },

  /* ---- 深色模式 ---- */
  onDarkMode() {
    const that = this
    wx.showActionSheet({
      itemList: THEME_OPTIONS,
      success(res) {
        const v = THEME_OPTIONS[res.tapIndex]
        wx.setStorageSync('panhub_dark', v)
        that.setData({ darkMode: v })
        wx.showToast({ title: '已设为' + v, icon: 'none' })
      }
    })
  },

  /* ---- 默认搜索平台 ---- */
  onDefaultSrc() {
    const that = this
    const list = ['全部平台', '夸克网盘', '阿里云盘', '百度网盘', '115 网盘', '迅雷网盘']
    wx.showActionSheet({
      itemList: list,
      success(res) {
        const v = list[res.tapIndex]
        wx.setStorageSync('panhub_src', v)
        that.setData({ defaultSrc: v })
        wx.showToast({ title: '已设为' + v, icon: 'none' })
      }
    })
  },

  /* ---- 结果排序 ---- */
  onSort() {
    const that = this
    wx.showActionSheet({
      itemList: SORT_OPTIONS,
      success(res) {
        const v = SORT_OPTIONS[res.tapIndex]
        wx.setStorageSync('panhub_sort', v)
        that.setData({ sortType: v })
        wx.showToast({ title: '已设为' + v, icon: 'none' })
      }
    })
  },

  /* ---- 清除搜索历史 ---- */
  onClearHistory() {
    const that = this
    wx.showModal({
      title: '清除搜索历史',
      content: '确定清除全部 ' + this.data.historyCount + ' 条搜索历史吗？',
      confirmColor: '#FA5151',
      success(res) {
        if (res.confirm) {
          wx.removeStorageSync('panhub_history')
          that.setData({ historyCount: 0 })
          wx.showToast({ title: '已清除', icon: 'success' })
        }
      }
    })
  },

  /* ---- 关于 ---- */
  onAbout() {
    wx.showModal({
      title: 'PanHub',
      content: '网盘资源聚合搜索 · ' + VERSION + '\n一个入口，搜遍全网网盘资源',
      showCancel: false,
      confirmColor: '#07C160'
    })
  },

  /* ---- 反馈建议 ---- */
  onFeedback() {
    wx.showModal({
      title: '反馈建议',
      content: '复制反馈邮箱，将你的建议发送给我们',
      confirmText: '复制邮箱',
      cancelText: '取消',
      success(res) {
        if (res.confirm) {
          wx.setClipboardData({
            data: 'feedback@panhub.shenzjd.com',
            success: () => wx.showToast({ title: '邮箱已复制', icon: 'success' })
          })
        }
      }
    })
  }
})
