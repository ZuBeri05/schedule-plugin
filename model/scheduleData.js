import fs from 'fs'
import YAML from 'yaml'

const dataPath = './data/schedule'

if (!fs.existsSync(dataPath)) {
  fs.mkdirSync(dataPath, { recursive: true })
}

export default class ScheduleData {
  static getDateString(timestamp = null) {
    const date = timestamp ? new Date(timestamp * 1000) : new Date()
    return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`
  }

  static getData(userId) {
    const file = `${dataPath}/${userId}.yaml`
    if (!fs.existsSync(file)) return null

    try {
      const data = YAML.parse(fs.readFileSync(file, 'utf8'))
      if (data && data.abandoned && !data.skipped) {
        data.skipped = { [data.abandoned]: ['__all__'] }
        delete data.abandoned
        fs.writeFileSync(file, YAML.stringify(data), 'utf8')
      }
      return data
    } catch (err) {
      logger.error(`[课程表] 读取数据失败: ${err}`)
      return null
    }
  }

  static setData(userId, name, semesterStart, courses, timezone = 'Asia/Shanghai') {
    const file = `${dataPath}/${userId}.yaml`

    courses.sort((a, b) => a.startTime.localeCompare(b.startTime))

    const oldData = this.getData(userId)
    const data = {
      name: name || '未知课表',
      semesterStart: semesterStart || 0,
      timezone,
      courses: courses || [],
      note: oldData?.note || {},
      skipped: oldData?.skipped || {}
    }

    if (data.abandoned) {
      data.skipped = data.skipped || {}
      data.skipped[data.abandoned] = ['__all__']
      delete data.abandoned
    }

    try {
      fs.writeFileSync(file, YAML.stringify(data), 'utf8')

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

  static getSkippedCourses(userId, dateStr) {
    const data = this.getData(userId)
    if (!data || !data.skipped) return []
    return data.skipped[dateStr] || []
  }

  static isCourseSkipped(userId, dateStr, courseName, startTime = null) {
    const skipped = this.getSkippedCourses(userId, dateStr)
    if (skipped.includes('__all__')) return true
    if (startTime) {
      return skipped.includes(`${courseName}@${startTime}`)
    }
    return skipped.includes(courseName)
  }

  static isAllSkipped(userId, dateStr) {
    const skipped = this.getSkippedCourses(userId, dateStr)
    return skipped.includes('__all__')
  }

  static skipCourse(userId, dateStr, courseKey) {
    const data = this.getData(userId)
    if (!data) return false

    if (!data.skipped) data.skipped = {}
    if (!data.skipped[dateStr]) data.skipped[dateStr] = []

    if (!data.skipped[dateStr].includes(courseKey)) {
      data.skipped[dateStr].push(courseKey)
    }

    const file = `${dataPath}/${userId}.yaml`
    try {
      fs.writeFileSync(file, YAML.stringify(data), 'utf8')
      return true
    } catch (err) {
      logger.error(`[课程表] 翘课设置失败: ${err}`)
      return false
    }
  }

  static skipAll(userId, dateStr) {
    const data = this.getData(userId)
    if (!data) return false

    if (!data.skipped) data.skipped = {}
    data.skipped[dateStr] = ['__all__']

    const file = `${dataPath}/${userId}.yaml`
    try {
      fs.writeFileSync(file, YAML.stringify(data), 'utf8')
      return true
    } catch (err) {
      logger.error(`[课程表] 请假设置失败: ${err}`)
      return false
    }
  }

  static unskipCourse(userId, dateStr, courseKey) {
    const data = this.getData(userId)
    if (!data || !data.skipped || !data.skipped[dateStr]) return false

    data.skipped[dateStr] = data.skipped[dateStr].filter(n => n !== courseKey)
    if (data.skipped[dateStr].length === 0) {
      delete data.skipped[dateStr]
    }

    const file = `${dataPath}/${userId}.yaml`
    try {
      fs.writeFileSync(file, YAML.stringify(data), 'utf8')
      return true
    } catch (err) {
      logger.error(`[课程表] 取消翘课失败: ${err}`)
      return false
    }
  }

  static unskipAll(userId, dateStr) {
    const data = this.getData(userId)
    if (!data || !data.skipped) return false

    delete data.skipped[dateStr]

    const file = `${dataPath}/${userId}.yaml`
    try {
      fs.writeFileSync(file, YAML.stringify(data), 'utf8')
      return true
    } catch (err) {
      logger.error(`[课程表] 取消请假失败: ${err}`)
      return false
    }
  }

  static isAbandoned(userId, timestamp = null) {
    const dateStr = this.getDateString(timestamp)
    return this.isAllSkipped(userId, dateStr)
  }

  static setAbandoned(userId, abandoned) {
    const dateStr = this.getDateString()
    if (abandoned) {
      return this.skipAll(userId, dateStr)
    } else {
      return this.unskipAll(userId, dateStr)
    }
  }
}
