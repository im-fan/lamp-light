const MAX_BRIGHTNESS = 95
const MIN_COLOR_TEMPERATURE = 1800
const MAX_COLOR_TEMPERATURE = 10000
const FULLSCREEN_TRANSITION_DURATION = 1200
const MAX_CUSTOM_COLORS = 20
const MAX_COLOR_NAME_LENGTH = 4
const CUSTOM_COLORS_STORAGE_KEY = 'customColors'
const PRESETS = {
  daylight: { label: '日光', swatch: '#ffffff', hue: 0, saturation: 0, colorTemperature: 6500, brightness: 95 },
  moonlight: { label: '月光', swatch: '#e5f0ff', hue: 210, saturation: 8, colorTemperature: 9000, brightness: 95 },
  reading: { label: '阅读', swatch: '#b3956b', colorTemperature: 3200, brightness: 70 }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function brightnessFromClientX(clientX, rect) {
  if (!rect || rect.width <= 0) return null
  return Math.round(clamp((clientX - rect.left) / rect.width, 0, 1) * MAX_BRIGHTNESS)
}

function normalizeColorName(value) {
  return Array.from(String(value || '').trim()).slice(0, MAX_COLOR_NAME_LENGTH).join('')
}

function hsvToRgb(hue, saturation, value) {
  const chroma = value * saturation
  const segment = hue / 60
  const x = chroma * (1 - Math.abs((segment % 2) - 1))
  const [red, green, blue] = [
    [chroma, x, 0], [x, chroma, 0], [0, chroma, x],
    [0, x, chroma], [x, 0, chroma], [chroma, 0, x]
  ][Math.floor(segment) % 6]
  const offset = value - chroma

  return [red, green, blue].map(channel => Math.round((channel + offset) * 255))
}

function rgbToHex(rgb) {
  return `#${rgb.map(channel => channel.toString(16).padStart(2, '0')).join('')}`
}

function normalizeCustomColors(value) {
  if (!Array.isArray(value)) return []

  const colors = []
  value.forEach((item, index) => {
    const name = normalizeColorName(item && item.name)
    const previewColor = String(item && item.previewColor || '').toLowerCase()
    const hue = Number(item && item.hue)
    const saturation = Number(item && item.saturation)
    const brightness = Number(item && item.brightness)

    if (!name || !/^#[0-9a-f]{6}$/.test(previewColor)) return
    if (![hue, saturation, brightness].every(Number.isFinite)) return
    if (colors.some(color => color.previewColor === previewColor)) return

    colors.push({
      id: String(item.id || `${previewColor}-${index}`),
      name,
      previewColor,
      hue: clamp(hue, 0, 360),
      saturation: clamp(saturation, 0, 100),
      brightness: clamp(brightness, 0, MAX_BRIGHTNESS)
    })
  })

  return colors.slice(0, MAX_CUSTOM_COLORS)
}

function colorTemperatureToHsv(colorTemperature) {
  const temperature = clamp(colorTemperature, MIN_COLOR_TEMPERATURE, MAX_COLOR_TEMPERATURE) / 100
  let red
  let green
  let blue

  if (temperature <= 66) {
    red = 255
    green = 99.47 * Math.log(temperature) - 161.12
    blue = temperature <= 19 ? 0 : 138.52 * Math.log(temperature - 10) - 305.04
  } else {
    red = 329.7 * Math.pow(temperature - 60, -0.1332)
    green = 288.12 * Math.pow(temperature - 60, -0.0755)
    blue = 255
  }

  const channels = [red, green, blue].map(channel => clamp(channel, 0, 255) / 255)
  const max = Math.max(...channels)
  const min = Math.min(...channels)
  const delta = max - min
  const saturation = max === 0 ? 0 : delta / max
  const hue = delta === 0 ? 0 : (([
    (channels[1] - channels[2]) / delta,
    (channels[2] - channels[0]) / delta + 2,
    (channels[0] - channels[1]) / delta + 4
  ][channels.indexOf(max)] * 60) + 360) % 360

  return { hue, saturation: saturation * 100 }
}

Page({
  data: {
    brightness: 79,
    colorTemperature: 5000,
    previewColor: '#2c95c9',
    markerX: 0,
    markerY: 0,
    isFullscreen: false,
    isOverlayVisible: false,
    isOverlayPrepared: false,
    fullscreenStyle: '',
    activePreset: '',
    activeCustomColorId: '',
    presetOptions: Object.keys(PRESETS).map(key => ({ key, ...PRESETS[key] })),
    customColors: [],
    isDeleteMode: false,
    isNameDialogVisible: false,
    customColorName: '',
    customColorNameLength: 0,
    editingCustomColorId: '',
    maxColorNameLength: MAX_COLOR_NAME_LENGTH,
    previewNoticeText: '',
    isPreviewNoticeVisible: false
  },

  onLoad() {
    const color = colorTemperatureToHsv(this.data.colorTemperature)
    this.hue = color.hue
    this.saturation = color.saturation
    this.originalScreenBrightness = null
    this.isFullscreenTransitioning = false
    this.wheelRect = null
    this.setData({ customColors: this.loadCustomColors() })
    this.updateColor()
    this.captureSystemBrightness()
  },

  loadCustomColors() {
    try {
      return normalizeCustomColors(wx.getStorageSync(CUSTOM_COLORS_STORAGE_KEY))
    } catch (error) {
      wx.showToast({ title: '读取本地颜色失败', icon: 'none' })
      return []
    }
  },

  onReady() {
    this.setupWheelRect()
    this.setupBrightnessRect()
  },

  onResize() {
    this.setupWheelRect()
    this.setupBrightnessRect()
  },

  onShow() {
    if (!this.data.isFullscreen) return
    this.setKeepScreenOn(true)
    this.applySystemBrightness()
  },

  onHide() {
    this.setKeepScreenOn(false)
    this.restoreSystemBrightness()
  },

  onUnload() {
    clearTimeout(this.previewNoticeTimer)
    this.setKeepScreenOn(false)
    this.restoreSystemBrightness()
  },

  captureSystemBrightness() {
    wx.getScreenBrightness({
      success: ({ value }) => {
        this.originalScreenBrightness = value
        const brightness = clamp(Math.round(value * 1000) / 10, 0, MAX_BRIGHTNESS)
        this.setData({ brightness })
        this.updateColor()
      }
    })
  },

  restoreSystemBrightness() {
    if (this.originalScreenBrightness === null) return
    wx.setScreenBrightness({ value: this.originalScreenBrightness })
  },

  applySystemBrightness() {
    wx.setScreenBrightness({ value: this.data.brightness / 100 })
  },

  setKeepScreenOn(keepScreenOn) {
    wx.setKeepScreenOn({ keepScreenOn })
  },

  toggleFullscreen() {
    if (this.isFullscreenTransitioning) return
    if (this.data.isFullscreen) {
      this.exitFullscreen()
      return
    }
    this.enterFullscreen()
  },

  getPreviewFrame(callback) {
    wx.createSelectorQuery()
      .in(this)
      .select('.preview-card')
      .boundingClientRect(callback)
      .exec()
  },

  previewFrameStyle(frame) {
    return `top:${frame.top}px;left:${frame.left}px;width:${frame.width}px;height:${frame.height}px;border-radius:32rpx;`
  },

  enterFullscreen() {
    this.isFullscreenTransitioning = true
    this.getPreviewFrame(frame => {
      if (!frame) {
        this.isFullscreenTransitioning = false
        return
      }

      this.setData({
        isFullscreen: true,
        isOverlayVisible: true,
        isOverlayPrepared: true,
        fullscreenStyle: this.previewFrameStyle(frame)
      }, () => {
        setTimeout(() => this.setData({
          isOverlayPrepared: false,
          fullscreenStyle: 'top:0;left:0;width:100vw;height:100vh;border-radius:0;'
        }), 16)
        setTimeout(() => {
          this.isFullscreenTransitioning = false
        }, FULLSCREEN_TRANSITION_DURATION)
      })
      this.setKeepScreenOn(true)
    })
  },

  exitFullscreen() {
    this.isFullscreenTransitioning = true
    this.getPreviewFrame(frame => {
      if (!frame) {
        this.isFullscreenTransitioning = false
        return
      }

      this.setData({
        isFullscreen: false,
        fullscreenStyle: this.previewFrameStyle(frame)
      })
      setTimeout(() => {
        this.setData({ isOverlayVisible: false })
        this.setKeepScreenOn(false)
        this.setupWheelRect()
        this.setupBrightnessRect()
        this.isFullscreenTransitioning = false
      }, FULLSCREEN_TRANSITION_DURATION)
    })
  },

  setupWheelRect() {
    wx.createSelectorQuery()
      .in(this)
      .select('#colorWheel')
      .boundingClientRect(rect => {
        if (!rect) return
        this.wheelRect = rect
        this.updateMarker()
      })
      .exec()
  },

  onWheelTouch(event) {
    this.setData({ activePreset: '', activeCustomColorId: '' })
    if (!this.wheelRect) return
    const touch = event.touches[0]
    if (!touch) return

    const x = clamp(touch.clientX - this.wheelRect.left, 0, this.wheelRect.width)
    const y = clamp(touch.clientY - this.wheelRect.top, 0, this.wheelRect.height)

    this.hue = x / this.wheelRect.width * 360
    this.saturation = y / this.wheelRect.height * 100
    this.updateColor()
    this.updateMarker()
  },

  setupBrightnessRect(callback) {
    wx.createSelectorQuery()
      .in(this)
      .select('#brightnessSlider')
      .boundingClientRect(rect => {
        if (!rect) return
        this.brightnessRect = rect
        if (callback) callback(rect)
      })
      .exec()
  },

  setBrightnessFromClientX(clientX, rect = this.brightnessRect) {
    const brightness = brightnessFromClientX(clientX, rect)
    if (brightness === null) return
    this.setData({ brightness, activePreset: '', activeCustomColorId: '' })
    this.updateColor()
    this.applySystemBrightness()
  },

  onBrightnessTouch(event) {
    const touch = event.touches && event.touches[0]
    if (!touch) return
    if (this.brightnessRect) {
      this.setBrightnessFromClientX(touch.clientX)
      return
    }
    this.setupBrightnessRect(rect => this.setBrightnessFromClientX(touch.clientX, rect))
  },

  applyPreset(event) {
    const presetName = event.currentTarget.dataset.preset
    const preset = PRESETS[presetName]
    if (!preset) return

    this.hue = preset.hue ?? colorTemperatureToHsv(preset.colorTemperature).hue
    this.saturation = preset.saturation ?? colorTemperatureToHsv(preset.colorTemperature).saturation
    this.setData({
      brightness: preset.brightness,
      colorTemperature: preset.colorTemperature,
      activePreset: presetName,
      activeCustomColorId: ''
    })
    this.updateColor()
    this.updateMarker()
    this.applySystemBrightness()
  },

  applyCustomColor(event) {
    const id = event.currentTarget.dataset.id
    const color = this.data.customColors.find(item => item.id === id)
    if (!color) return

    this.hue = color.hue
    this.saturation = color.saturation
    this.setData({
      brightness: color.brightness,
      activePreset: '',
      activeCustomColorId: color.id
    })
    this.updateColor()
    this.updateMarker()
    this.applySystemBrightness()
  },

  saveCurrentColor() {
    if (this.data.customColors.length >= MAX_CUSTOM_COLORS) {
      wx.showToast({ title: '最多保存20个颜色', icon: 'none' })
      return
    }
    if (this.data.customColors.some(color => color.previewColor === this.data.previewColor)) {
      this.showPreviewNotice('这个颜色已经添加过了~')
      return
    }

    this.setData({
      isDeleteMode: false,
      isNameDialogVisible: true,
      customColorName: '',
      customColorNameLength: 0,
      editingCustomColorId: ''
    })
  },

  showPreviewNotice(text) {
    clearTimeout(this.previewNoticeTimer)
    this.setData({ previewNoticeText: text, isPreviewNoticeVisible: true })
    this.previewNoticeTimer = setTimeout(() => {
      this.setData({ isPreviewNoticeVisible: false })
    }, 3000)
  },

  onCustomColorNameInput(event) {
    const customColorName = event.detail.value
    this.setData({
      customColorName,
      customColorNameLength: Array.from(customColorName).length
    })
  },

  closeNameDialog() {
    this.setData({
      isNameDialogVisible: false,
      customColorName: '',
      customColorNameLength: 0,
      editingCustomColorId: ''
    })
  },

  editCustomColorName(event) {
    const id = event.currentTarget.dataset.id
    const color = this.data.customColors.find(item => item.id === id)
    if (!color) return

    this.setData({
      isDeleteMode: false,
      isNameDialogVisible: true,
      customColorName: color.name,
      customColorNameLength: Array.from(color.name).length,
      editingCustomColorId: id
    })
  },

  confirmSaveColor() {
    const name = normalizeColorName(this.data.customColorName)
    if (!name) {
      wx.showToast({ title: '请输入颜色名称', icon: 'none' })
      return
    }

    if (this.data.editingCustomColorId) {
      const customColors = this.data.customColors.map(color => (
        color.id === this.data.editingCustomColorId ? { ...color, name } : color
      ))
      if (!this.persistCustomColors(customColors)) return
      this.closeNameDialog()
      wx.showToast({ title: '已修改', icon: 'success' })
      return
    }
    if (this.data.customColors.some(color => color.previewColor === this.data.previewColor)) {
      this.closeNameDialog()
      this.showPreviewNotice('这个颜色已经添加过了~')
      return
    }
    if (this.data.customColors.length >= MAX_CUSTOM_COLORS) {
      this.closeNameDialog()
      wx.showToast({ title: '最多保存20个颜色', icon: 'none' })
      return
    }

    const color = {
      id: `${Date.now().toString(36)}-${this.data.previewColor.slice(1)}`,
      name,
      previewColor: this.data.previewColor,
      hue: this.hue,
      saturation: this.saturation,
      brightness: this.data.brightness
    }
    const customColors = [...this.data.customColors, color]
    if (!this.persistCustomColors(customColors)) return

    this.setData({
      isNameDialogVisible: false,
      customColorName: '',
      customColorNameLength: 0,
      editingCustomColorId: '',
      activePreset: '',
      activeCustomColorId: color.id
    })
    wx.showToast({ title: '已保存', icon: 'success' })
  },

  enterDeleteMode() {
    if (!this.data.customColors.length) return
    this.setData({ isDeleteMode: true })
  },

  exitDeleteMode() {
    if (this.data.isDeleteMode) this.setData({ isDeleteMode: false })
  },

  deleteCustomColor(event) {
    const id = event.currentTarget.dataset.id
    const customColors = this.data.customColors.filter(item => item.id !== id)
    if (customColors.length === this.data.customColors.length) return
    if (!this.persistCustomColors(customColors)) return

    this.setData({
      isDeleteMode: customColors.length > 0,
      activeCustomColorId: this.data.activeCustomColorId === id ? '' : this.data.activeCustomColorId
    })
  },

  persistCustomColors(customColors) {
    try {
      wx.setStorageSync(CUSTOM_COLORS_STORAGE_KEY, customColors)
      this.setData({ customColors })
      return true
    } catch (error) {
      wx.showToast({ title: '本地保存失败', icon: 'none' })
      return false
    }
  },

  stopPropagation() {},

  updateColor() {
    const previewColor = rgbToHex(hsvToRgb(this.hue, this.saturation / 100, this.data.brightness / 100))
    this.setData({ previewColor })
  },

  updateMarker() {
    if (!this.wheelRect) return
    this.setData({
      markerX: this.wheelRect.width * this.hue / 360,
      markerY: this.wheelRect.height * this.saturation / 100
    })
  }
})

console.assert(rgbToHex(hsvToRgb(0, 1, 1)) === '#ff0000', 'HSV red conversion failed')
console.assert(rgbToHex(hsvToRgb(120, 1, 1)) === '#00ff00', 'HSV green conversion failed')
console.assert(rgbToHex(hsvToRgb(240, 1, 1)) === '#0000ff', 'HSV blue conversion failed')
console.assert(PRESETS.daylight.saturation === 0, 'Daylight must be pure white')
console.assert(PRESETS.moonlight.hue > 180 && PRESETS.moonlight.saturation > 0, 'Moonlight must be cool white')

console.assert(normalizeCustomColors([{ name: '暖光', previewColor: '#ffffff', hue: 0, saturation: 0, brightness: 95 }]).length === 1, 'Custom color normalization failed')
console.assert(normalizeCustomColors([{ name: '', previewColor: '#ffffff', hue: 0, saturation: 0, brightness: 95 }]).length === 0, 'Unnamed custom color must be rejected')

console.assert(brightnessFromClientX(50, { left: 0, width: 100 }) === 48, 'Brightness position mapping failed')
console.assert(normalizeColorName('  测试颜色名称  ') === '测试颜色', 'Color name length limit failed')
