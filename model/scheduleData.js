import fs from 'fs'
import YAML from 'yaml'

const dataPath = './data/schedule'

// 确保数据目录存在
if (!fs.existsSync(dataPath)) {
  fs.mkdirSync(dataPath, { recursive: true })
}

/**
 * 课程表数据模型
 */
export default class ScheduleData {
  /**
   * 获取用户课表数据
   * @param {string|number} userId 用户ID
   * @returns {object|null} 课表数据
   */
  static getData(userId) {
    const file = `${dataPath}/${userId}.yaml`
    if (!fs.existsSync(file)) return null
    
    try {
      const data = YAML.parse(fs.readFileSync(file, 'utf8'))
      return data
    } catch (err) {
      logger.error(`[课程表] 读取数据失败: ${err}`)
      return null
    }
  }

  /**
   * 保存用户课表数据
   * @param {string|number} userId 用户ID
   * @param {string} name 课表名称
   * @param {number} semesterStart 学期开始时间戳（秒）
   * @param {array} courses 课程列表
   * @param {string} timezone 时区
   * @returns {boolean} 是否成功
   */
  static setData(userId, name, semesterStart, courses, timezone = 'Asia/Shanghai') {
    const file = `${dataPath}/${userId}.yaml`
    
    // 按开始时间排序
    courses.sort((a, b) => a.startTime.localeCompare(b.startTime))
    
    const data = {
      name: name || '未知课表',
      semesterStart: semesterStart || 0,
      timezone,
      courses: courses || [],
      note: this.getData(userId)?.note || {},
      abandoned: null
    }
    
    try {
      fs.writeFileSync(file, YAML.stringify(data), 'utf8')
      
      // 清理不存在课程的备注
      const courseNames = courses.map(c => c.name)
      const removedNotes = []
      for (const courseName in data.note) {
        if (!courseNames.includes(courseName)) {
          removedNotes.push(courseName)
          delete data.note[courseName]
        }
      }
      
      if (removedNotes.length > 0) {
        fs.writeFileSync(file, YAML.stringify(data), 'utf8')
        return { success: true, removedNotes }
      }
      
      return { success: true }
    } catch (err) {
      logger.error(`[课程表] 保存数据失败: ${err}`)
      return { success: false }
    }
  }

  /**
   * 删除用户课表数据
   * @param {string|number} userId 用户ID
   * @returns {boolean} 是否成功
   */
  static deleteData(userId) {
    const file = `${dataPath}/${userId}.yaml`
    if (!fs.existsSync(file)) return false
    
    try {
      fs.unlinkSync(file)
      return true
    } catch (err) {
      logger.error(`[课程表] 删除数据失败: ${err}`)
      return false
    }
  }

  /**
   * 设置课程备注
   * @param {string|number} userId 用户ID
   * @param {string} courseName 课程名称
   * @param {string} note 备注内容（null表示删除）
   * @returns {boolean} 是否成功
   */
  static setNote(userId, courseName, note) {
    const data = this.getData(userId)
    if (!data) return false
    
    if (!data.note) data.note = {}
    
    if (note === null) {
      delete data.note[courseName]
    } else {
      data.note[courseName] = note
    }
    
    const file = `${dataPath}/${userId}.yaml`
    try {
      fs.writeFileSync(file, YAML.stringify(data), 'utf8')
      return true
    } catch (err) {
      logger.error(`[课程表] 设置备注失败: ${err}`)
      return false
    }
  }

  /**
   * 设置/取消翘课标记
   * @param {string|number} userId 用户ID
   * @param {boolean} abandoned 是否翘课
   * @returns {boolean} 是否成功
   */
  static setAbandoned(userId, abandoned) {
    const data = this.getData(userId)
    if (!data) return false
    
    const now = new Date()
    data.abandoned = abandoned ? `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}` : null
    
    const file = `${dataPath}/${userId}.yaml`
    try {
      fs.writeFileSync(file, YAML.stringify(data), 'utf8')
      return true
    } catch (err) {
      logger.error(`[课程表] 设置翘课失败: ${err}`)
      return false
    }
  }

  /**
   * 检查是否翘课
   * @param {string|number} userId 用户ID
   * @param {number} timestamp 时间戳（秒）
   * @returns {boolean} 是否翘课
   */
  static isAbandoned(userId, timestamp = null) {
    const data = this.getData(userId)
    if (!data || !data.abandoned) return false
    
    const date = new Date((timestamp || Date.now() / 1000) * 1000)
    const dateStr = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`
    
    return data.abandoned === dateStr
  }
}
