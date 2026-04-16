import plugin from '../../../lib/plugins/plugin.js'
import ScheduleData from '../model/scheduleData.js'
import { getCourses, getTimezoneGMTOffset } from '../utils/scheduleUtils.js'
import { segment } from 'oicq'

let puppeteer = null
try {
  puppeteer = (await import('../../../lib/puppeteer/puppeteer.js')).default
} catch (err) {
  logger.warn('[课程表] 未找到 puppeteer，图片功能将不可用')
}

function courseKey(name, startTime) {
  return `${name}@${startTime}`
}

function isSkippedEntry(skippedList, name, startTime) {
  return skippedList.includes(courseKey(name, startTime))
}

export class schedule extends plugin {
  constructor() {
    super({
      name: '课程表',
      dsc: '课程表查询功能',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '^#课表\\s*$',
          fnc: 'checkSchedule'
        },
        {
          reg: '^#课表\\s+(.+)$',
          fnc: 'checkScheduleWithDate'
        },
        {
          reg: '^#(删除|清空)课表',
          fnc: 'deleteSchedule'
        },
        {
          reg: '^#翘课\\s*$',
          fnc: 'skipCourse'
        },
        {
          reg: '^#翘课\\s+列表\\s*$',
          fnc: 'showSkipList'
        },
        {
          reg: '^#翘课\\s+(.+)$',
          fnc: 'skipCourse'
        },
        {
          reg: '^#取消翘课\\s*$',
          fnc: 'showUnskipList'
        },
        {
          reg: '^#取消翘课\\s+(.+)$',
          fnc: 'unskipCourse'
        },
        {
          reg: '^#请假\\s*$',
          fnc: 'skipAll'
        },
        {
          reg: '^#取消请假\\s*$',
          fnc: 'unskipAll'
        },
        {
          reg: '^#课表帮助\\s*$',
          fnc: 'showHelp'
        },
        {
          reg: '^#?群友在上什么课\\s*$',
          fnc: 'groupScheduleText'
        },
        {
          reg: '^#?群友在上什么课\\s+(.+)$',
          fnc: 'groupScheduleWithDate'
        }
      ]
    })
  }

  getTargetUser(e) {
    let atId = e.at
    if (Array.isArray(atId)) atId = atId[0]
    if (atId && String(atId) === String(e.bot?.uin || e.bot?.account?.uin)) atId = null
    if (atId) {
      return { userId: atId, isOther: true }
    }
    return { userId: e.user_id, isOther: false }
  }

  isAdmin(e) {
    if (e.isMaster) return true
    if (e.member && (e.member.is_admin || e.member.is_owner)) return true
    return false
  }

  resolveTargetUser(e, requireAdminForOther = false) {
    const { userId, isOther } = this.getTargetUser(e)
    if (isOther && requireAdminForOther && !this.isAdmin(e)) {
      return { error: true, msg: '仅管理员可替他人操作' }
    }
    return { userId, isOther, error: false }
  }

  async checkSchedule(e) {
    const { userId, isOther } = this.resolveTargetUser(e)
    const data = ScheduleData.getData(userId)

    if (!data) {
      await e.reply(isOther ? '该用户尚未导入课表' : '你还没有导入课表哦~\n使用 #导入课表 查看导入方法')
      return true
    }

    const courses = getCourses(data)
    const dateStr = ScheduleData.getDateString()
    const skippedList = ScheduleData.getSkippedCourses(userId, dateStr)
    const isLeave = skippedList.includes('__all__')

    if (courses === false) {
      await e.reply('课程表未配置或该学期课程已结束')
      return true
    }

    const coursesWithStatus = courses.map(course => ({
      ...course,
      note: data.note && data.note[course.name] ? data.note[course.name] : null,
      skipped: isLeave || isSkippedEntry(skippedList, course.name, course.startTime)
    }))

    const skippedCount = coursesWithStatus.filter(c => c.skipped).length

    try {
      const now = new Date()
      const renderData = {
        date: `${now.getFullYear()}年${String(now.getMonth() + 1).padStart(2, '0')}月${String(now.getDate()).padStart(2, '0')}日`,
        timezone: data.timezone !== 'Asia/Shanghai' ? getTimezoneGMTOffset(data.timezone) : null,
        courses: coursesWithStatus,
        isLeave,
        skippedCount,
        timestamp: now.toLocaleString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        })
      }

      const img = await this.renderScheduleImage(renderData)

      if (img) {
        await e.reply(img)
      } else {
        await this.sendScheduleText(e, coursesWithStatus, isLeave, data.timezone)
      }
    } catch (err) {
      logger.error('[课程表] 渲染失败:', err)
      await this.sendScheduleText(e, coursesWithStatus, isLeave, data.timezone)
    }

    return true
  }

  async sendScheduleText(e, courses, isLeave, timezone) {
    const msgs = ['今日课程：']
    const tz = getTimezoneGMTOffset(timezone)
    if (tz !== 'GMT+8') {
      msgs.push(`(${tz})`)
    }

    if (courses.length === 0) {
      msgs.push('今日无课~')
    } else {
      for (const course of courses) {
        let msg = `${course.startTime}~${course.endTime} ${course.name}`
        if (course.skipped) {
          msg += '（翘课）'
        }
        if (course.location) {
          msg += ` @ ${course.location}`
        }
        if (course.note) {
          msg += `\n  备注: ${course.note}`
        }
        msgs.push(msg)
      }
    }

    if (isLeave) {
      msgs.push('\n📋 今日已请假')
    } else {
      const skippedNames = courses.filter(c => c.skipped).map(c => c.name)
      if (skippedNames.length > 0) {
        msgs.push(`\n🏃 已翘课: ${skippedNames.join('、')}`)
      }
    }

    await e.reply(msgs.join('\n'))
  }

  async checkScheduleWithDate(e) {
    const rawDateStr = e.msg.replace(/^#课表\s+/, '').trim()
    const { userId, isOther } = this.resolveTargetUser(e)
    const dateStr = rawDateStr

    const data = ScheduleData.getData(userId)
    if (!data) {
      await e.reply(isOther ? '该用户尚未导入课表' : '你还没有导入课表哦~\n使用 #导入课表 查看导入方法')
      return true
    }

    let timestamp
    let dateDisplay
    try {
      const now = new Date()
      let targetDate = new Date()

      if (dateStr === '明天' || dateStr === '明日') {
        targetDate.setDate(now.getDate() + 1)
      } else if (dateStr === '后天') {
        targetDate.setDate(now.getDate() + 2)
      } else if (dateStr === '昨天' || dateStr === '昨日') {
        targetDate.setDate(now.getDate() - 1)
      } else if (dateStr === '今天' || dateStr === '今日') {
        targetDate = now
      } else if (dateStr.match(/^周[一二三四五六日天]$/)) {
        const weekMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 }
        const targetWeekday = weekMap[dateStr.charAt(1)]
        const currentWeekday = now.getDay()
        let diff = targetWeekday - currentWeekday
        if (diff <= 0) diff += 7
        targetDate.setDate(now.getDate() + diff)
      } else if (dateStr.match(/^下周[一二三四五六日天]$/)) {
        const weekMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 }
        const targetWeekday = weekMap[dateStr.charAt(2)]
        const currentWeekday = now.getDay()
        let diff = targetWeekday - currentWeekday
        if (diff <= 0) diff += 7
        diff += 7
        targetDate.setDate(now.getDate() + diff)
      } else {
        targetDate = new Date(dateStr)
        if (isNaN(targetDate.getTime())) {
          throw new Error('Invalid date')
        }
      }

      timestamp = Math.floor(targetDate.getTime() / 1000)
      dateDisplay = `${targetDate.getFullYear()}年${String(targetDate.getMonth() + 1).padStart(2, '0')}月${String(targetDate.getDate()).padStart(2, '0')}日`
    } catch {
      await e.reply('日期格式错误\n支持格式：\n- 明天、后天、昨天\n- 周一、周二...周日\n- 下周一、下周二...下周日\n- 2024-03-15')
      return true
    }

    const courses = getCourses(data, timestamp)

    if (courses === false) {
      await e.reply(`${dateDisplay} 课程表未配置或该学期课程已结束`)
      return true
    }

    const targetDateStr = ScheduleData.getDateString(timestamp)
    const skippedList = ScheduleData.getSkippedCourses(userId, targetDateStr)
    const isLeave = skippedList.includes('__all__')

    const coursesWithStatus = courses.map(course => ({
      ...course,
      note: data.note && data.note[course.name] ? data.note[course.name] : null,
      skipped: isLeave || isSkippedEntry(skippedList, course.name, course.startTime)
    }))

    const skippedCount = coursesWithStatus.filter(c => c.skipped).length

    try {
      const renderData = {
        date: dateDisplay,
        timezone: data.timezone !== 'Asia/Shanghai' ? getTimezoneGMTOffset(data.timezone) : null,
        courses: coursesWithStatus,
        isLeave,
        skippedCount,
        timestamp: new Date().toLocaleString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        })
      }

      const img = await this.renderScheduleImage(renderData)

      if (img) {
        await e.reply(img)
      } else {
        await this.sendScheduleDateText(e, dateDisplay, coursesWithStatus, data.timezone, isLeave)
      }
    } catch (err) {
      logger.error('[课程表] 渲染失败:', err)
      await this.sendScheduleDateText(e, dateDisplay, coursesWithStatus, data.timezone, isLeave)
    }

    return true
  }

  async sendScheduleDateText(e, dateDisplay, courses, timezone, isLeave = false) {
    const msgs = [`${dateDisplay} 课程：`]
    const tz = getTimezoneGMTOffset(timezone)
    if (tz !== 'GMT+8') {
      msgs.push(`(${tz})`)
    }

    if (courses.length === 0) {
      msgs.push('无课~')
    } else {
      for (const course of courses) {
        let msg = `${course.startTime}~${course.endTime} ${course.name}`
        if (course.skipped) {
          msg += '（翘课）'
        }
        if (course.location) {
          msg += ` @ ${course.location}`
        }
        if (course.note) {
          msg += `\n  备注: ${course.note}`
        }
        msgs.push(msg)
      }
    }

    if (isLeave) {
      msgs.push('\n📋 已请假')
    } else {
      const skippedNames = courses.filter(c => c.skipped).map(c => c.name)
      if (skippedNames.length > 0) {
        msgs.push(`\n🏃 已翘课: ${skippedNames.join('、')}`)
      }
    }

    await e.reply(msgs.join('\n'))
  }

  async deleteSchedule(e) {
    const result = this.resolveTargetUser(e, true)
    if (result.error) {
      await e.reply(result.msg)
      return true
    }

    const { userId, isOther } = result
    const data = ScheduleData.getData(userId)

    if (!data) {
      await e.reply('未储存课程表信息')
      return true
    }

    const success = ScheduleData.deleteData(userId)
    if (success) {
      await e.reply(`删除课表「${data.name}」成功${isOther ? ` (替 <${userId}> 操作)` : ''}`)
    } else {
      await e.reply('删除失败')
    }

    return true
  }

  async showSkipList(e) {
    const result = this.resolveTargetUser(e, true)
    if (result.error) {
      await e.reply(result.msg)
      return true
    }

    const { userId, isOther } = result
    const data = ScheduleData.getData(userId)

    if (!data) {
      await e.reply('尚未导入课表数据\n请先使用 #导入课表 导入课表数据')
      return true
    }

    const courses = getCourses(data)
    if (courses === false) {
      await e.reply('课程表未配置或该学期课程已结束')
      return true
    }

    if (courses.length === 0) {
      await e.reply('今日无课，无需翘课~')
      return true
    }

    const dateStr = ScheduleData.getDateString()
    const skippedList = ScheduleData.getSkippedCourses(userId, dateStr)

    const msgs = ['📚 今日课程：']
    for (let i = 0; i < courses.length; i++) {
      const course = courses[i]
      const isSkipped = isSkippedEntry(skippedList, course.name, course.startTime) || skippedList.includes('__all__')
      const skipTag = isSkipped ? ' [已翘课]' : ''
      msgs.push(`${i + 1}. ${course.startTime}~${course.endTime} ${course.name}${skipTag}`)
    }
    msgs.push('')
    msgs.push('使用 #翘课 序号 或 #翘课 课程名 标记翘课')
    msgs.push('使用 #请假 标记全天请假')

    if (isOther) {
      msgs[0] = `📚 <${userId}> 今日课程：`
    }

    await e.reply(msgs.join('\n'))
    return true
  }

  async skipCourse(e) {
    const result = this.resolveTargetUser(e, true)
    if (result.error) {
      await e.reply(result.msg)
      return true
    }

    const { userId, isOther } = result
    const data = ScheduleData.getData(userId)

    if (!data) {
      await e.reply('尚未导入课表数据\n请先使用 #导入课表 导入课表数据')
      return true
    }

    const courses = getCourses(data)
    if (courses === false || courses.length === 0) {
      await e.reply('今日无课，无需翘课~')
      return true
    }

    let input = e.msg.replace(/^#翘课\s*/, '').trim()
    input = input.replace(/@\d+\s*$/, '').trim()

    const dateStr = ScheduleData.getDateString()
    const skippedList = ScheduleData.getSkippedCourses(userId, dateStr)

    if (skippedList.includes('__all__')) {
      await e.reply('今日已请假，所有课程均标记翘课\n如需取消请先 #取消请假')
      return true
    }

    let targetCourse = null

    if (!input) {
      const now = new Date()
      const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

      let currentCourse = null
      let nextCourse = null

      for (const course of courses) {
        if (currentTime >= course.startTime && currentTime < course.endTime) {
          currentCourse = course
          break
        }
        if (currentTime < course.startTime) {
          nextCourse = course
          break
        }
      }

      targetCourse = currentCourse || nextCourse

      if (!targetCourse) {
        await e.reply('今日课程已结束，无需翘课~')
        return true
      }

      if (isSkippedEntry(skippedList, targetCourse.name, targetCourse.startTime)) {
        await e.reply(`「${targetCourse.name}」已经翘课了哦~`)
        return true
      }
    } else {
      const index = parseInt(input)
      if (!isNaN(index) && index >= 1 && index <= courses.length) {
        targetCourse = courses[index - 1]
      } else {
        const matched = courses.filter(c => c.name.includes(input))
        if (matched.length === 1) {
          targetCourse = matched[0]
        } else if (matched.length > 1) {
          const msgs = ['找到多门同名课程，请用序号指定：']
          for (let i = 0; i < courses.length; i++) {
            if (courses[i].name.includes(input)) {
              msgs.push(`${i + 1}. ${courses[i].startTime}~${courses[i].endTime} ${courses[i].name}`)
            }
          }
          await e.reply(msgs.join('\n'))
          return true
        } else {
          await e.reply(`未找到课程「${input}」\n使用 #翘课 列表 查看今日课程列表`)
          return true
        }
      }
    }

    if (isSkippedEntry(skippedList, targetCourse.name, targetCourse.startTime)) {
      await e.reply(`「${targetCourse.name}」已经翘课了哦~`)
      return true
    }

    const key = courseKey(targetCourse.name, targetCourse.startTime)
    const success = ScheduleData.skipCourse(userId, dateStr, key)
    if (success) {
      const otherHint = isOther ? ` (替 <${userId}> 操作)` : ''
      await e.reply(`🏃 已翘课: ${targetCourse.name} (${targetCourse.startTime})${otherHint}`)
    } else {
      await e.reply('操作失败')
    }

    return true
  }

  async showUnskipList(e) {
    const result = this.resolveTargetUser(e, true)
    if (result.error) {
      await e.reply(result.msg)
      return true
    }

    const { userId, isOther } = result
    const dateStr = ScheduleData.getDateString()
    const skippedList = ScheduleData.getSkippedCourses(userId, dateStr)

    if (skippedList.length === 0) {
      await e.reply('今日没有翘课记录~')
      return true
    }

    if (skippedList.includes('__all__')) {
      await e.reply('今日已请假（全天翘课）\n使用 #取消请假 取消')
      return true
    }

    const msgs = ['🏃 今日已翘课课程：']
    for (let i = 0; i < skippedList.length; i++) {
      const entry = skippedList[i]
      const atIndex = entry.indexOf('@')
      const displayName = atIndex > 0 ? `${entry.substring(0, atIndex)} (${entry.substring(atIndex + 1)})` : entry
      msgs.push(`${i + 1}. ${displayName}`)
    }
    msgs.push('')
    msgs.push('使用 #取消翘课 序号 或 #取消翘课 课程名 取消翘课')

    await e.reply(msgs.join('\n'))
    return true
  }

  async unskipCourse(e) {
    const result = this.resolveTargetUser(e, true)
    if (result.error) {
      await e.reply(result.msg)
      return true
    }

    const { userId, isOther } = result
    const dateStr = ScheduleData.getDateString()
    const skippedList = ScheduleData.getSkippedCourses(userId, dateStr)

    if (skippedList.length === 0) {
      await e.reply('今日没有翘课记录~')
      return true
    }

    if (skippedList.includes('__all__')) {
      await e.reply('今日已请假，请先 #取消请假 再取消单门课程翘课')
      return true
    }

    let input = e.msg.replace(/^#取消翘课\s+/, '').trim()
    input = input.replace(/@\d+\s*$/, '').trim()

    let targetKey = null

    const index = parseInt(input)
    if (!isNaN(index) && index >= 1 && index <= skippedList.length) {
      targetKey = skippedList[index - 1]
    } else {
      const matched = skippedList.filter(n => n.includes(input))
      if (matched.length === 1) {
        targetKey = matched[0]
      } else if (matched.length > 1) {
        const displayItems = matched.map(entry => {
          const atIndex = entry.indexOf('@')
          return atIndex > 0 ? `${entry.substring(0, atIndex)} (${entry.substring(atIndex + 1)})` : entry
        })
        await e.reply(`找到多个匹配: ${displayItems.join('、')}\n请用序号指定`)
        return true
      }
    }

    if (!targetKey) {
      await e.reply(`未找到翘课记录「${input}」\n使用 #取消翘课 查看翘课列表`)
      return true
    }

    const success = ScheduleData.unskipCourse(userId, dateStr, targetKey)
    if (success) {
      const atIndex = targetKey.indexOf('@')
      const displayName = atIndex > 0 ? `${targetKey.substring(0, atIndex)} (${targetKey.substring(atIndex + 1)})` : targetKey
      const otherHint = isOther ? ` (替 <${userId}> 操作)` : ''
      await e.reply(`✅ 已取消翘课: ${displayName}${otherHint}`)
    } else {
      await e.reply('操作失败')
    }

    return true
  }

  async skipAll(e) {
    const result = this.resolveTargetUser(e, true)
    if (result.error) {
      await e.reply(result.msg)
      return true
    }

    const { userId, isOther } = result
    const data = ScheduleData.getData(userId)

    if (!data) {
      await e.reply('尚未导入课表数据\n请先使用 #导入课表 导入课表数据')
      return true
    }

    const dateStr = ScheduleData.getDateString()
    const success = ScheduleData.skipAll(userId, dateStr)
    if (success) {
      const otherHint = isOther ? ` (替 <${userId}> 操作)` : ''
      await e.reply(`📋 今日已请假，所有课程标记翘课${otherHint}`)
    } else {
      await e.reply('操作失败')
    }

    return true
  }

  async unskipAll(e) {
    const result = this.resolveTargetUser(e, true)
    if (result.error) {
      await e.reply(result.msg)
      return true
    }

    const { userId, isOther } = result
    const dateStr = ScheduleData.getDateString()
    const isLeave = ScheduleData.isAllSkipped(userId, dateStr)

    if (!isLeave) {
      const skippedList = ScheduleData.getSkippedCourses(userId, dateStr)
      if (skippedList.length === 0) {
        await e.reply('今日没有请假/翘课记录~')
      } else {
        await e.reply('今日未请假，但有单门课程翘课\n使用 #取消翘课 课程名 取消单门翘课')
      }
      return true
    }

    const success = ScheduleData.unskipAll(userId, dateStr)
    if (success) {
      const otherHint = isOther ? ` (替 <${userId}> 操作)` : ''
      await e.reply(`✅ 已取消今日请假${otherHint}`)
    } else {
      await e.reply('操作失败')
    }

    return true
  }

  async showHelp(e) {
    if (!puppeteer) {
      const msg = [
        '📚 课程表帮助',
        '',
        '【课表导入】',
        '• 直接发送WakeUp分享口令',
        '• #导入wakeup <口令>',
        '• #导入ics <链接>',
        '',
        '【课表查询】',
        '• #课表 - 查看今日课表',
        '• #课表 明天 - 查看指定日期',
        '• #课表@某人 - 查看他人课表',
        '• 群友在上什么课 - 查看群友课表',
        '',
        '【翘课/请假】',
        '• #翘课 - 翘当前课/下一节课',
        '• #翘课 课程名/序号 - 翘指定课程',
        '• #翘课 列表 - 查看今日课程列表',
        '• #取消翘课 课程名/序号 - 取消翘课',
        '• #请假 - 全天请假',
        '• #取消请假 - 取消请假',
        '',
        '【管理员操作】',
        '• 以上指令后加@某人 可替他人操作',
        '• 翘课/请假/导入/删除 需管理员权限',
        '',
        '【日期格式】',
        '明天、后天、周一~周日、下周一~下周日、2024-03-15'
      ]
      await e.reply(msg.join('\n'))
      return true
    }

    try {
      const data = {
        pluResPath: `./plugins/yunzai-schedule-plugin/resources/`,
        watermark: `Created by Yunzai-Bot  ©${new Date().getFullYear()} Schedule Plugin`
      }

      const img = await puppeteer.screenshot('schedule-plugin', {
        tplFile: './plugins/schedule-plugin/resources/html/help.html',
        ...data
      })

      if (img) {
        await e.reply(img)
      } else {
        const msg = [
          '📚 课程表帮助',
          '',
          '【课表导入】',
          '• 直接发送WakeUp分享口令',
          '• #导入wakeup <口令>',
          '• #导入ics <链接>',
          '',
          '【课表查询】',
          '• #课表 - 查看今日课表',
          '• #课表 明天 - 查看指定日期',
          '• #课表@某人 - 查看他人课表',
          '• 群友在上什么课 - 查看群友课表',
          '',
          '【翘课/请假】',
          '• #翘课 - 翘当前课/下一节课',
          '• #翘课 课程名/序号 - 翘指定课程',
          '• #翘课 列表 - 查看今日课程列表',
          '• #取消翘课 课程名/序号 - 取消翘课',
          '• #请假 - 全天请假',
          '• #取消请假 - 取消请假',
          '',
          '【管理员操作】',
          '• 以上指令后加@某人 可替他人操作',
          '• 翘课/请假/导入/删除 需管理员权限'
        ]
        await e.reply(msg.join('\n'))
      }
    } catch (err) {
      logger.error('[课程表] 帮助渲染失败:', err)
      await e.reply('帮助加载失败')
    }

    return true
  }

  async groupScheduleText(e) {
    return await this.renderGroupSchedule(e, null)
  }

  async groupScheduleWithDate(e) {
    const dateStr = e.msg.replace(/^#?群友在上什么课\s+/, '').trim()
    return await this.renderGroupSchedule(e, dateStr)
  }

  async renderGroupSchedule(e, dateStr) {
    if (!e.isGroup) {
      if (dateStr) {
        e.msg = `#课表 ${dateStr}`
        return await this.checkScheduleWithDate(e)
      } else {
        return await this.checkSchedule(e)
      }
    }

    let timestamp = Math.floor(Date.now() / 1000)
    let dateDisplay = '今日'

    if (dateStr) {
      try {
        const now = new Date()
        let targetDate = new Date()

        if (dateStr === '明天' || dateStr === '明日') {
          targetDate.setDate(now.getDate() + 1)
        } else if (dateStr === '后天') {
          targetDate.setDate(now.getDate() + 2)
        } else if (dateStr === '昨天' || dateStr === '昨日') {
          targetDate.setDate(now.getDate() - 1)
        } else if (dateStr === '今天' || dateStr === '今日') {
          targetDate = now
        } else if (dateStr.match(/^周[一二三四五六日天]$/)) {
          const weekMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 }
          const targetWeekday = weekMap[dateStr.charAt(1)]
          const currentWeekday = now.getDay()
          let diff = targetWeekday - currentWeekday
          if (diff <= 0) diff += 7
          targetDate.setDate(now.getDate() + diff)
        } else if (dateStr.match(/^下周[一二三四五六日天]$/)) {
          const weekMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 }
          const targetWeekday = weekMap[dateStr.charAt(2)]
          const currentWeekday = now.getDay()
          let diff = targetWeekday - currentWeekday
          if (diff <= 0) diff += 7
          diff += 7
          targetDate.setDate(now.getDate() + diff)
        } else {
          targetDate = new Date(dateStr)
          if (isNaN(targetDate.getTime())) {
            throw new Error('Invalid date')
          }
        }

        timestamp = Math.floor(targetDate.getTime() / 1000)
        const date = new Date(timestamp * 1000)
        dateDisplay = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`
      } catch {
        await e.reply('日期格式错误\n支持格式：明天、后天、周一~周日、下周一~下周日、2024-03-15')
        return true
      }
    }

    const current = timestamp
    const currentTime = new Date(timestamp * 1000).toTimeString().slice(0, 5)

    let memberList = []
    try {
      logger.info(`[课程表] 开始获取群成员列表，群号: ${e.group_id}`)

      if (e.group) {
        if (typeof e.group.getMemberMap === 'function') {
          logger.info('[课程表] 使用方式1: e.group.getMemberMap')
          const memberMap = await e.group.getMemberMap()
          memberList = Array.from(memberMap.values())
        } else if (e.bot && e.bot.pickGroup) {
          logger.info('[课程表] 使用方式2: e.bot.pickGroup')
          const group = e.bot.pickGroup(e.group_id)
          const memberMap = await group.getMemberMap()
          memberList = Array.from(memberMap.values())
        } else if (Bot && Bot.gl && Bot.gl.get(e.group_id)) {
          logger.info('[课程表] 使用方式3: Bot.gl.get')
          const group = Bot.gl.get(e.group_id)
          memberList = Array.from(group.values())
        }
      }

      logger.info(`[课程表] 获取到 ${memberList.length} 个群成员`)

      if (memberList.length === 0) {
        logger.warn('[课程表] 无法获取群成员列表')
        await e.reply('暂未配置课程表哦…\n使用 #导入课表 指令即可设置～')
        return true
      }
    } catch (err) {
      logger.error('[课程表] 获取群成员失败:', err)
      await e.reply('获取群成员列表失败')
      return true
    }

    const results = []
    const statusTypes = ['分身中', '进行中', '翘课中', '下一节', '已结束', '无课程']
    const targetDateStr = ScheduleData.getDateString(current)

    for (const member of memberList) {
      const userId = member.user_id
      const data = ScheduleData.getData(userId)

      if (!data) continue

      const todayCourses = getCourses(data, current)
      if (todayCourses === false) continue

      const nickname = member.card || member.nickname || userId
      const skippedList = ScheduleData.getSkippedCourses(userId, targetDateStr)
      const isLeave = skippedList.includes('__all__')

      if (todayCourses.length === 0) {
        results.push({
          userId,
          nickname,
          type: 5,
          isLeave: false,
          mainDesc: '今日无课程',
          subDesc: '好好休息~',
          order: 999999,
          subOrder: 0
        })
        continue
      }

      const nowCourses = []
      let nextCourse = null

      for (const course of todayCourses) {
        if (currentTime < course.startTime) {
          if (nowCourses.length === 0 && !nextCourse) {
            nextCourse = course
          }
          break
        } else if (currentTime >= course.startTime && currentTime < course.endTime) {
          nowCourses.push(course)
        }
      }

      const timezone = data.timezone || 'Asia/Shanghai'
      const timezoneHint = timezone === 'Asia/Shanghai' ? '' : ` (${timezone})`

      if (nowCourses.length > 0) {
        const course = nowCourses[0]
        const endTime = new Date()
        const [h, m] = course.endTime.split(':')
        endTime.setHours(parseInt(h), parseInt(m), 0)
        const remain = Math.ceil((endTime - Date.now()) / 60000)

        if (isLeave) {
          results.push({
            userId,
            nickname,
            type: 2,
            isLeave: true,
            isSkipped: false,
            mainDesc: '今日请假',
            subDesc: timezoneHint ? `时区 ${timezone}` : '全天休息',
            order: remain,
            subOrder: new Date(`1970-01-01 ${course.startTime}`).getTime()
          })
        } else if (nowCourses.length > 1) {
          const descriptions = nowCourses.map(c => {
            const skipped = isSkippedEntry(skippedList, c.name, c.startTime)
            return `${c.name.charAt(0)}${skipped ? '[翘]' : ''}${c.startTime}-${c.endTime}`
          })
          results.push({
            userId,
            nickname,
            type: 0,
            isLeave: false,
            isSkipped: false,
            mainDesc: nowCourses.map(c => {
              const skipped = isSkippedEntry(skippedList, c.name, c.startTime)
              return skipped ? `${c.name}[翘]` : c.name
            }).join(' / '),
            subDesc: descriptions.join(' / ') + timezoneHint,
            order: remain,
            subOrder: new Date(`1970-01-01 ${course.startTime}`).getTime()
          })
        } else {
          const isCourseSkipped = isSkippedEntry(skippedList, course.name, course.startTime)
          results.push({
            userId,
            nickname,
            type: isCourseSkipped ? 2 : 1,
            isLeave: false,
            isSkipped: isCourseSkipped,
            mainDesc: course.name,
            subDesc: `${course.startTime}-${course.endTime}${timezoneHint} (剩余 ${remain} 分钟)`,
            order: remain,
            subOrder: new Date(`1970-01-01 ${course.startTime}`).getTime()
          })
        }
      } else if (nextCourse) {
        const startTime = new Date()
        const [h, m] = nextCourse.startTime.split(':')
        startTime.setHours(parseInt(h), parseInt(m), 0)
        const remain = Math.ceil((startTime - Date.now()) / 60000)
        const remainText = remain > 60 ? `${Math.floor(remain / 60)} 小时` : `${remain} 分钟`

        if (isLeave) {
          results.push({
            userId,
            nickname,
            type: 2,
            isLeave: true,
            isSkipped: false,
            mainDesc: '今日请假',
            subDesc: timezoneHint ? `时区 ${timezone}` : '全天休息',
            order: new Date(`1970-01-01 ${nextCourse.startTime}`).getTime(),
            subOrder: new Date(`1970-01-01 ${nextCourse.endTime}`).getTime()
          })
        } else {
          const isNextSkipped = isSkippedEntry(skippedList, nextCourse.name, nextCourse.startTime)
          results.push({
            userId,
            nickname,
            type: 3,
            isLeave: false,
            isSkipped: isNextSkipped,
            mainDesc: nextCourse.name,
            subDesc: `${nextCourse.startTime}-${nextCourse.endTime}${timezoneHint} (${remainText}后)`,
            order: new Date(`1970-01-01 ${nextCourse.startTime}`).getTime(),
            subOrder: new Date(`1970-01-01 ${nextCourse.endTime}`).getTime()
          })
        }
      } else {
        const totalMinutes = todayCourses.reduce((sum, c) => {
          const [sh, sm] = c.startTime.split(':')
          const [eh, em] = c.endTime.split(':')
          return sum + (parseInt(eh) * 60 + parseInt(em) - parseInt(sh) * 60 - parseInt(sm))
        }, 0)
        const hours = (totalMinutes / 60).toFixed(1)

        if (isLeave) {
          results.push({
            userId,
            nickname,
            type: 2,
            isLeave: true,
            isSkipped: false,
            mainDesc: '今日请假',
            subDesc: timezoneHint ? `时区 ${timezone}` : '课程已结束',
            order: -parseFloat(hours),
            subOrder: 0
          })
        } else {
          const hasSkipped = todayCourses.some(c => isSkippedEntry(skippedList, c.name, c.startTime))
          results.push({
            userId,
            nickname,
            type: 4,
            isLeave: false,
            isSkipped: hasSkipped,
            mainDesc: '今日课程已上完',
            subDesc: `共计 ${hours} 小时`,
            order: -parseFloat(hours),
            subOrder: 0
          })
        }
      }
    }

    if (results.length === 0) {
      await e.reply('暂无群友配置了课程表哦…\n使用 #导入课表 指令即可设置～')
      return true
    }

    results.sort((a, b) => {
      if (a.type !== b.type) return a.type - b.type
      if (a.order !== b.order) return a.order - b.order
      return a.subOrder - b.subOrder
    })

    try {
      const data = {
        results,
        statusTypes,
        timestamp: new Date().toLocaleString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        }).replace(/\//g, '-'),
        groupId: e.group_id
      }

      const img = await this.renderImage(data)

      if (img) {
        await e.reply(img)
      } else {
        await this.sendTextVersion(e, results, statusTypes)
      }
    } catch (err) {
      logger.error('[课程表] 渲染图片失败:', err)
      await this.sendTextVersion(e, results, statusTypes)
    }

    return true
  }

  async renderImage(data) {
    if (!puppeteer) {
      logger.warn('[课程表] puppeteer 不可用')
      return null
    }

    try {
      return await puppeteer.screenshot('schedule-plugin', {
        tplFile: './plugins/schedule-plugin/resources/html/groupSchedule.html',
        ...data
      })
    } catch (err) {
      logger.error('[课程表] puppeteer 渲染失败:', err)
      return null
    }
  }

  async renderScheduleImage(data) {
    if (!puppeteer) {
      logger.warn('[课程表] puppeteer 不可用')
      return null
    }

    try {
      return await puppeteer.screenshot('schedule-plugin', {
        tplFile: './plugins/schedule-plugin/resources/html/schedule.html',
        ...data
      })
    } catch (err) {
      logger.error('[课程表] 个人课表渲染失败:', err)
      return null
    }
  }

  async sendTextVersion(e, results, statusTypes) {
    const msgs = ['📚 群友课表状态\n']
    for (const result of results) {
      const statusEmoji = ['🔴', '🔴', '🟠', '🔵', '🟢', '⚪', '🟠'][result.isLeave ? 6 : result.type]
      const statusText = result.isLeave ? '请假中' : statusTypes[result.type]
      const skipHint = (result.isSkipped && !result.isLeave) ? ' [已翘]' : ''
      msgs.push(`${statusEmoji} ${result.nickname}`)
      msgs.push(`   [${statusText}${skipHint}] ${result.mainDesc}`)
      if (result.subDesc) {
        msgs.push(`   ${result.subDesc}`)
      }
    }
    msgs.push(`\n💡 使用 #导入课表 设置你的课表`)

    await e.reply(msgs.join('\n'))
  }
}
