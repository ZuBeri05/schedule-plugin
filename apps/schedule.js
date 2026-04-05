import plugin from '../../../lib/plugins/plugin.js'
import ScheduleData from '../model/scheduleData.js'
import { getCourses, getTimezoneGMTOffset } from '../utils/scheduleUtils.js'
import { segment } from 'oicq'

// 导入 puppeteer
let puppeteer = null
try {
  puppeteer = (await import('../../../lib/puppeteer/puppeteer.js')).default
} catch (err) {
  logger.warn('[课程表] 未找到 puppeteer，图片功能将不可用')
}

/**
 * 课程表主功能
 */
export class schedule extends plugin {
  constructor() {
    super({
      name: '课程表',
      dsc: '课程表查询功能',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '^#课表$',
          fnc: 'checkSchedule'
        },
        {
          reg: '^#课表\\s+(.+)$',
          fnc: 'checkScheduleWithDate'
        },
        {
          reg: '^#(删除|清空)课表$',
          fnc: 'deleteSchedule'
        },
        {
          reg: '^#翘课$',
          fnc: 'toggleAbandoned'
        },
        {
          reg: '^#课表帮助$',
          fnc: 'showHelp'
        },
        {
          reg: '^#?群友在上什么课$',
          fnc: 'groupScheduleText'
        },
        {
          reg: '^#?群友在上什么课\\s+(.+)$',
          fnc: 'groupScheduleWithDate'
        }
      ]
    })
  }

  /**
   * 查询今日课表
   */
  async checkSchedule(e) {
    const userId = e.user_id
    const data = ScheduleData.getData(userId)
    
    if (!data) {
      await e.reply('你还没有导入课表哦~\n使用 #导入课表 查看导入方法')
      return true
    }
    
    const courses = getCourses(data)
    const isAbandoned = ScheduleData.isAbandoned(userId)
    
    if (courses === false) {
      await e.reply('课程表未配置或该学期课程已结束')
      return true
    }

    // 添加备注信息
    const coursesWithNote = courses.map(course => ({
      ...course,
      note: data.note && data.note[course.name] ? data.note[course.name] : null
    }))

    // 渲染图片
    try {
      const now = new Date()
      const renderData = {
        date: `${now.getFullYear()}年${String(now.getMonth() + 1).padStart(2, '0')}月${String(now.getDate()).padStart(2, '0')}日`,
        timezone: data.timezone !== 'Asia/Shanghai' ? getTimezoneGMTOffset(data.timezone) : null,
        courses: coursesWithNote,
        isAbandoned,
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
        // 降级到文字版
        await this.sendScheduleText(e, coursesWithNote, isAbandoned, data.timezone)
      }
    } catch (err) {
      logger.error('[课程表] 渲染失败:', err)
      await this.sendScheduleText(e, coursesWithNote, isAbandoned, data.timezone)
    }
    
    return true
  }

  /**
   * 发送文字版课表
   */
  async sendScheduleText(e, courses, isAbandoned, timezone) {
    if (courses.length === 0) {
      await e.reply('今日无课~')
      return
    }

    const msgs = ['今日课程：']
    const tz = getTimezoneGMTOffset(timezone)
    if (tz !== 'GMT+8') {
      msgs.push(`(${tz})`)
    }
    
    for (const course of courses) {
      let msg = `${course.startTime}~${course.endTime} ${course.name}`
      if (course.location) {
        msg += ` @ ${course.location}`
      }
      if (course.note) {
        msg += `\n  备注: ${course.note}`
      }
      msgs.push(msg)
    }
    
    if (isAbandoned) {
      msgs.push('\n⚠️ 今日已标记翘课')
    }
    
    await e.reply(msgs.join('\n'))
  }

  /**
   * 查询指定日期课表
   */
  async checkScheduleWithDate(e) {
    const userId = e.user_id
    const dateStr = e.msg.replace(/^#课表\s+/, '').trim()
    
    const data = ScheduleData.getData(userId)
    if (!data) {
      await e.reply('你还没有导入课表哦~\n使用 #导入课表 查看导入方法')
      return true
    }
    
    // 解析日期
    let timestamp
    let dateDisplay
    try {
      // 处理中文日期
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
        // 处理"周一"到"周日"
        const weekMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 }
        const targetWeekday = weekMap[dateStr.charAt(1)]
        const currentWeekday = now.getDay()
        let diff = targetWeekday - currentWeekday
        if (diff <= 0) diff += 7 // 下周
        targetDate.setDate(now.getDate() + diff)
      } else if (dateStr.match(/^下周[一二三四五六日天]$/)) {
        // 处理"下周一"到"下周日"
        const weekMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 }
        const targetWeekday = weekMap[dateStr.charAt(2)]
        const currentWeekday = now.getDay()
        let diff = targetWeekday - currentWeekday
        if (diff <= 0) diff += 7
        diff += 7 // 加一周
        targetDate.setDate(now.getDate() + diff)
      } else {
        // 尝试解析标准日期格式
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

    // 添加备注信息
    const coursesWithNote = courses.map(course => ({
      ...course,
      note: data.note && data.note[course.name] ? data.note[course.name] : null
    }))

    // 渲染图片
    try {
      const renderData = {
        date: dateDisplay,
        timezone: data.timezone !== 'Asia/Shanghai' ? getTimezoneGMTOffset(data.timezone) : null,
        courses: coursesWithNote,
        isAbandoned: false,
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
        // 降级到文字版
        await this.sendScheduleDateText(e, dateDisplay, coursesWithNote, data.timezone)
      }
    } catch (err) {
      logger.error('[课程表] 渲染失败:', err)
      await this.sendScheduleDateText(e, dateDisplay, coursesWithNote, data.timezone)
    }
    
    return true
  }

  /**
   * 发送指定日期文字版课表
   */
  async sendScheduleDateText(e, dateDisplay, courses, timezone) {
    if (courses.length === 0) {
      await e.reply(`${dateDisplay} 无课~`)
      return
    }

    const msgs = [`${dateDisplay} 课程：`]
    const tz = getTimezoneGMTOffset(timezone)
    if (tz !== 'GMT+8') {
      msgs.push(`(${tz})`)
    }
    
    for (const course of courses) {
      let msg = `${course.startTime}~${course.endTime} ${course.name}`
      if (course.location) {
        msg += ` @ ${course.location}`
      }
      if (course.note) {
        msg += `\n  备注: ${course.note}`
      }
      msgs.push(msg)
    }
    
    await e.reply(msgs.join('\n'))
  }

  /**
   * 删除课表
   */
  async deleteSchedule(e) {
    const userId = e.user_id
    const data = ScheduleData.getData(userId)
    
    if (!data) {
      await e.reply('未储存课程表信息')
      return true
    }
    
    const success = ScheduleData.deleteData(userId)
    if (success) {
      await e.reply(`删除课表「${data.name}」成功`)
    } else {
      await e.reply('删除失败')
    }
    
    return true
  }

  /**
   * 切换翘课状态
   */
  async toggleAbandoned(e) {
    const userId = e.user_id
    const data = ScheduleData.getData(userId)
    
    if (!data) {
      await e.reply('尚未导入课表数据，无法设置翘课\n请先使用 #导入课表 导入课表数据')
      return true
    }
    
    const isAbandoned = ScheduleData.isAbandoned(userId)
    const success = ScheduleData.setAbandoned(userId, !isAbandoned)
    
    if (success) {
      await e.reply(isAbandoned ? '已取消今日翘课~' : '已设置今日翘课~')
    } else {
      await e.reply('操作失败')
    }
    
    return true
  }

  /**
   * 显示帮助
   */
  async showHelp(e) {
    if (!puppeteer) {
      // 降级到文字版
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
        '• 群友在上什么课 - 查看群友课表',
        '',
        '【其他功能】',
        '• #翘课 - 标记翘课',
        '• #删除课表 - 删除数据',
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
        // 降级到文字版
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
          '• 群友在上什么课 - 查看群友课表',
          '',
          '【其他功能】',
          '• #翘课 - 标记翘课',
          '• #删除课表 - 删除数据'
        ]
        await e.reply(msg.join('\n'))
      }
    } catch (err) {
      logger.error('[课程表] 帮助渲染失败:', err)
      await e.reply('帮助加载失败')
    }

    return true
  }

  /**
   * 群友课表（图片版）
   */
  async groupScheduleText(e) {
    return await this.renderGroupSchedule(e, null)
  }

  /**
   * 群友课表（指定日期）
   */
  async groupScheduleWithDate(e) {
    const dateStr = e.msg.replace(/^#?群友在上什么课\s+/, '').trim()
    return await this.renderGroupSchedule(e, dateStr)
  }

  /**
   * 渲染群友课表
   */
  async renderGroupSchedule(e, dateStr) {
    // 私聊时显示个人课表
    if (!e.isGroup) {
      if (dateStr) {
        e.msg = `#课表 ${dateStr}`
        return await this.checkScheduleWithDate(e)
      } else {
        return await this.checkSchedule(e)
      }
    }

    // 解析日期
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
    
    // 获取群成员列表
    let memberList = []
    try {
      logger.info(`[课程表] 开始获取群成员列表，群号: ${e.group_id}`)
      
      // TRSS-Yunzai / Miao-Yunzai 获取群成员方式
      if (e.group) {
        // 方式1: getMemberMap
        if (typeof e.group.getMemberMap === 'function') {
          logger.info('[课程表] 使用方式1: e.group.getMemberMap')
          const memberMap = await e.group.getMemberMap()
          memberList = Array.from(memberMap.values())
        }
        // 方式2: pickMember (TRSS-Yunzai)
        else if (e.bot && e.bot.pickGroup) {
          logger.info('[课程表] 使用方式2: e.bot.pickGroup')
          const group = e.bot.pickGroup(e.group_id)
          const memberMap = await group.getMemberMap()
          memberList = Array.from(memberMap.values())
        }
        // 方式3: 直接从 Bot
        else if (Bot && Bot.gl && Bot.gl.get(e.group_id)) {
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

    for (const member of memberList) {
      const userId = member.user_id
      const data = ScheduleData.getData(userId)
      
      if (!data) continue

      const todayCourses = getCourses(data, current)
      if (todayCourses === false) continue

      const nickname = member.card || member.nickname || userId
      const isAbandoned = ScheduleData.isAbandoned(userId)

      if (todayCourses.length === 0) {
        results.push({
          userId,
          nickname,
          type: 5,
          mainDesc: '今日无课程',
          subDesc: '好好休息~',
          order: 999999,
          subOrder: 0
        })
        continue
      }

      // 查找当前/下节课
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

        if (nowCourses.length > 1) {
          const descriptions = nowCourses.map(c => 
            `${c.name.charAt(0)}${c.startTime}-${c.endTime}`
          )
          results.push({
            userId,
            nickname,
            type: 0,
            mainDesc: nowCourses.map(c => c.name).join(' / '),
            subDesc: descriptions.join(' / ') + timezoneHint,
            order: remain,
            subOrder: new Date(`1970-01-01 ${course.startTime}`).getTime()
          })
        } else {
          results.push({
            userId,
            nickname,
            type: isAbandoned ? 2 : 1,
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
        
        results.push({
          userId,
          nickname,
          type: 3,
          mainDesc: nextCourse.name,
          subDesc: `${nextCourse.startTime}-${nextCourse.endTime}${timezoneHint} (${remainText}后)`,
          order: new Date(`1970-01-01 ${nextCourse.startTime}`).getTime(),
          subOrder: new Date(`1970-01-01 ${nextCourse.endTime}`).getTime()
        })
      } else {
        const totalMinutes = todayCourses.reduce((sum, c) => {
          const [sh, sm] = c.startTime.split(':')
          const [eh, em] = c.endTime.split(':')
          return sum + (parseInt(eh) * 60 + parseInt(em) - parseInt(sh) * 60 - parseInt(sm))
        }, 0)
        const hours = (totalMinutes / 60).toFixed(1)
        
        results.push({
          userId,
          nickname,
          type: 4,
          mainDesc: '今日课程已上完',
          subDesc: `共计 ${hours} 小时`,
          order: -parseFloat(hours),
          subOrder: 0
        })
      }
    }

    if (results.length === 0) {
      await e.reply('暂无群友配置了课程表哦…\n使用 #导入课表 指令即可设置～')
      return true
    }

    // 排序
    results.sort((a, b) => {
      if (a.type !== b.type) return a.type - b.type
      if (a.order !== b.order) return a.order - b.order
      return a.subOrder - b.subOrder
    })

    // 渲染图片
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

      // 使用云崽的渲染功能
      const img = await this.renderImage(data)
      
      if (img) {
        await e.reply(img)
      } else {
        // 降级到文字版
        await this.sendTextVersion(e, results, statusTypes)
      }
    } catch (err) {
      logger.error('[课程表] 渲染图片失败:', err)
      // 降级到文字版
      await this.sendTextVersion(e, results, statusTypes)
    }

    return true
  }

  /**
   * 渲染图片（使用云崽的 puppeteer）
   */
  async renderImage(data) {
    if (!puppeteer) {
      logger.warn('[课程表] puppeteer 不可用')
      return null
    }
    
    try {
      // 云崽标准渲染方式
      return await puppeteer.screenshot('schedule-plugin', {
        tplFile: './plugins/schedule-plugin/resources/html/groupSchedule.html',
        ...data
      })
    } catch (err) {
      logger.error('[课程表] puppeteer 渲染失败:', err)
      return null
    }
  }

  /**
   * 渲染个人课表图片
   */
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

  /**
   * 发送文字版本（降级方案）
   */
  async sendTextVersion(e, results, statusTypes) {
    const msgs = ['📚 群友课表状态\n']
    for (const result of results) {
      const statusEmoji = ['🔴', '🔴', '🟠', '🔵', '🟢', '⚪'][result.type]
      msgs.push(`${statusEmoji} ${result.nickname}`)
      msgs.push(`   [${statusTypes[result.type]}] ${result.mainDesc}`)
      if (result.subDesc) {
        msgs.push(`   ${result.subDesc}`)
      }
    }
    msgs.push(`\n💡 使用 #导入课表 设置你的课表`)

    await e.reply(msgs.join('\n'))
  }
}
