const api = require('../../utils/api.js')

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function dayKey(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

function dayLabel(d) {
  return (d.getMonth() + 1) + '/' + d.getDate()
}

// 内联 SVG 图标
const svg = (body) =>
  'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none">' + body + '</svg>'
  )

const FLAME =
  '<path d="M12 21C7.6 21 4 17.9 4 13.9C4 10.5 6.9 8 8.5 6.2C9 5.7 10 5.8 10.2 6.6C10.4 7.4 10.2 8.3 10.6 9C11 8 11.6 6.7 11.5 5C11.4 4.1 12.3 3.7 13 4.3C15.5 6.6 20 9.8 20 13.9C20 17.9 16.4 21 12 21Z" fill="COLOR"/><path d="M12 21C10.1 21 8.5 19.6 8.5 17.7C8.5 16 9.7 14.7 10.8 13.5C11.1 13.1 11.8 13.2 11.9 13.8C12.1 14.5 12 15.1 12.3 15.7C12.7 14.8 13.1 13.8 13.1 12.3C13.1 11.2 14.2 10.7 14.8 11.5C15.8 12.9 16.3 14.4 16.3 15.6C16.3 18.1 14.5 21 12 21Z" fill="COLOR2"/>'

const ARROW = '<path d="M12 4L4 16H20L12 4Z" fill="COLOR"/>'

const ICONS = {
  flameRed: svg(FLAME.replace('COLOR', '#FA5151').replace('COLOR2', '#FCA5A5')),
  flameWeak: svg(FLAME.replace('COLOR', '#FA5151').replace('COLOR2', '#FA5151')),
  arrowRed: svg(ARROW.replace('COLOR', '#FA5151')),
  arrowGray: svg(ARROW.replace('COLOR', '#888888'))
}

Page({
  data: {
    todayKey: '',
    days: [],
    selected: '',
    loadingDay: false,
    hasData: false,
    topItems: [],
    soarItems: [],
    flameRed: ICONS.flameRed,
    flameWeak: ICONS.flameWeak,
    arrowRed: ICONS.arrowRed,
    arrowGray: ICONS.arrowGray
  },

  onLoad() {
    const today = new Date()
    this.setData({ todayKey: dayKey(today) })
    this.loadCalendar()
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 })
    }
  },

  loadCalendar() {
    api.getHotCalendar(30).then(res => {
      const list = (res && res.code === 0 && res.data && res.data.days) || []
      const map = {}
      list.forEach(d => {
        if (d.date) map[d.date] = d.count || 0
      })
      // 最近 7 天（含今天），今天固定高亮
      const days = []
      for (let i = 6; i >= 0; i--) {
        const d = new Date()
        d.setDate(d.getDate() - i)
        const key = dayKey(d)
        days.push({
          key,
          label: dayLabel(d),
          count: map[key] || 0,
          isToday: i === 0
        })
      }
      const selected = days[days.length - 1].key
      this.setData({ days, selected })
      this.loadDay(selected)
    }).catch(() => {
      this.setData({ hasData: false })
    })
  },

  selectDay(e) {
    const key = e.currentTarget.dataset.key
    if (!key || key === this.data.selected) return
    this.setData({ selected: key })
    this.loadDay(key)
  },

  loadDay(key) {
    this.setData({ loadingDay: true, hasData: true })
    const d = new Date(key + 'T00:00:00')
    d.setDate(d.getDate() - 1)
    const yKey = dayKey(d)

    Promise.all([api.getHotDay(key), api.getHotDay(yKey)])
      .then(([todayRes, yRes]) => {
        const todayItems = (todayRes && todayRes.code === 0 && todayRes.data && todayRes.data.items) || []
        const yItems = (yRes && yRes.code === 0 && yRes.data && yRes.data.items) || []
        const yMap = {}
        yItems.forEach(it => { if (it.term) yMap[it.term] = it.count || 0 })
        const todayMap = {}
        todayItems.forEach(it => { if (it.term) todayMap[it.term] = it.count || 0 })

        // 今日 TOP（前 6，含相对昨日涨幅）
        const topItems = todayItems.slice(0, 6).map((it, i) => {
          const yc = yMap[it.term] || 0
          return {
            rank: i + 1,
            term: it.term,
            count: it.count || 0,
            pct: yc > 0 ? Math.round(((it.count || 0) - yc) / yc * 100) : 0
          }
        })

        // 飙升榜：今日 count > 昨日 count 的词，按涨幅排序取前 4
        const soar = []
        for (const t in todayMap) {
          const yc = yMap[t] || 0
          if (yc > 0 && todayMap[t] > yc) {
            soar.push({ term: t, pct: Math.round((todayMap[t] - yc) / yc * 100) })
          }
        }
        soar.sort((a, b) => b.pct - a.pct)

        this.setData({
          topItems,
          soarItems: soar.slice(0, 4),
          loadingDay: false,
          hasData: topItems.length > 0
        })
      })
      .catch(() => {
        this.setData({ loadingDay: false, hasData: false })
      })
  },

  // 点击词条 → 回首页搜索
  onTapTerm(e) {
    const term = e.currentTarget.dataset.term
    if (!term) return
    wx.setStorageSync('panhub_quick_kw', term)
    wx.switchTab({ url: '/pages/index/index' })
  }
})
