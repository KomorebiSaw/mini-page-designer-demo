import cssobjCore from 'cssobj-core'
import postcss from 'postcss'
import cssobjPluginGencss from 'cssobj-plugin-gencss'
import selectorParser from 'postcss-selector-parser'

var src =
  'h1#ioj.app{font-size:12px;color:blue;}\n@media(max-width: 800px){color:purple; p{color:red;}}'

var reOneRule = /^(?:charset|import|namespace)/
var reGroupRule = /^(?:media|document|supports|page|keyframes)/

function camelCase(input) {
  // skip --color props
  if (/^-{2,}/.test(input)) return input
  // make -ms-prop result in msProp
  if (input.indexOf('-ms-') === 0) input = input.slice(1)
  return input.toLowerCase().replace(/-(.)/g, function (match, char) {
    return char.toUpperCase()
  })
}

function parseMixin(sel) {
  var match = sel && sel.match(/^\s*([\.\#a-z0-9\&_-]+)\s*\((.*)\)\s*$/i)
  if (match) {
    return [match[1], match[2].split(/\s*[;,]\s*/g)]
  }
}

function parseExtend(sel) {
  var match = sel && sel.match(/^\s*([^@]+)\s*:extend\((.*)\)\s*$/i)
  if (match) {
    return [match[1], match[2]]
  }
}

function joinLines(str) {
  return str
    .split(/[\n\r]/)
    .map(function (s) {
      return s.trim()
    })
    .join(' ')
}

function strToObj(str) {
  if (/^\s*{/.test(str)) str = 'exports=' + str
  var ret = new Function('exports', str + ';return exports')({})
  if (ret.__esModule) ret = ret.default
  return ret
}

var syntax = {
  css: '',
}

function convertObj(src, format, option) {
  option = option || {}

  if (format == 'js') {
    var cssobj = cssobjCore({ plugins: [cssobjPluginGencss(option)] })
    var ret = cssobj(src && typeof src === 'object' ? src : strToObj(src))
    return ret.css
  }

  var store = {}
  var curObj = null

  try {
    var ast = postcss([]).process(src, { parser: syntax[format] }).result.root
    // var ast = postcss.parse(src).toResult().root
  } catch (e) {
    console.log('parse error', e)
    return e
  }

  if (!ast) return {}

  // get class, id selector names
  var nameStore = {
    classes: {},
    ids: {},
  }
  const extractNames = (selectors) => {
    selectors.walkClasses((selector) => {
      // do something with the selector
      // console.log('class:', String(selector))
      const name = String(selector).slice(1)
      if (/[\(\[,\s\>\~\+]/.test(name)) return
      nameStore.classes[name] = String(name)
    })
    selectors.walkIds((selector) => {
      // do something with the selector
      // console.log('id:', String(selector))
      const name = String(selector).slice(1)
      nameStore.ids[name] = String(name)
    })
  }
  var selectorProcessor = selectorParser(extractNames)
  const selectorPlugin = postcss.plugin('extractNames', (options) => {
    return (root) => {
      root.walkRules((rule) => {
        selectorProcessor.processSync(rule)
      })
    }
  })

  var name = function (v) {
    // if(v.selector) {
    //   console.log(v.selector)
    // }

    // if (v.type == 'atrule') return util.format('@%s %s', v.name, joinLines(v.params))
    if (v.type == 'atrule') return `@${v.name} ${joinLines(v.params)}`

    if (v.type == 'rule') return joinLines(v.selector)

    /* no need since cssobj-core 1.1.1
      .replace( /&/g,
                // how to deal with & ?
                // stylus using \& to escape, SCSS/LESS replace only in selector
                format==='less'
                ? '&'
                : backSlash + '&'
              )
    */
  }

  var getObj = function (v) {
    var n = store,
      path = []
    while (v.parent && v.parent.type != 'root') {
      path.unshift(name(v.parent))
      v = v.parent
    }
    for (var i = 0; i < path.length; i++) {
      n = n[path[i]]
    }
    return n
  }

  ast.walk(function (v) {
    var obj = (v.parent && v.parent.obj) || store
    switch (v.type) {
      case 'atrule':
        if (reOneRule.test(v.name)) {
          arrayKV(obj, '@' + v.name, v.params)
        } else {
          var sel = name(v)
          var body = {}

          if (Array.isArray(obj)) {
            obj.push({ [sel]: body })
          } else if (sel in obj) {
            arrayKV(obj, sel, body)
          } else {
            obj[sel] = body
          }
          // if (Array.isArray(obj)) obj.push({[key]: body})
          // else if(!(key in obj)) obj[key] = body
          // else body = obj[key]
          v.obj = body
        }
        break
      case 'rule':
        if (format == 'less') {
          var arrExt = parseExtend(v.selector)
          var arrMix = parseMixin(v.selector)
          if (arrExt) v.selector = arrExt[0]
        }
        selectorProcessor.processSync(v.selector)
        var sel = name(v)
        var body = {}
        // it's LESS :extend / mixin
        if (v.ruleWithoutBody) {
          // console.log(sel, parseExtend(sel), parseMixin(sel))
          if (v.extendRule) {
            // combine & selector into parent
            if (arrExt[0] == '&') {
              sel = '$extend'
              body = arrExt[1] || ''
            } else {
              sel = arrExt[0]
              body.$extend = arrExt[1] || ''
            }
          } else if (arrMix) {
            sel = '$mixin'
            body[arrMix[0]] = arrMix[1].map(function (value) {
              return Number(value) == value ? Number(value) : value
            })
          }
        } else {
          // mixin & extend in selector with prop
          if (arrMix) {
            // fix $vars order poblem
            body.$vars = {}
          }
          if (arrExt) {
            body.$extend = arrExt[1] || ''
          }
        }
        if (Array.isArray(obj)) {
          obj.push({ [sel]: body })
        } else if (sel in obj) {
          arrayKV(obj, sel, body)
        } else {
          obj[sel] = body
        }
        v.obj = body
        break
      case 'decl':
        // put back IE hacks from v.raws
        var prop = ''
        var important = v.important ? ' !important' : ''
        var value = v.value + important

        if (!obj) return
        // if(obj && obj.constructor == Array) obj = obj[obj.length-1]

        // css hacks stored in v.raws.before
        var prefix = v.raws.before.match(/[*_]+$/)

        if (prefix) prop += prefix.pop()

        if (Number(value) == value) value = Number(value)

        // remove prefix prop version from result
        if (!option.keepVendor) {
          !['-webkit-', '-moz-', 'ms-', '-o-'].forEach(function (vendor) {
            var p = camelCase(vendor + v.prop)
            if (p in obj && value == obj[p]) {
              delete obj[p]
            }
          })
        }

        // @prop don't camelcase
        prop += /^\s*@/i.test(v.prop) ? v.prop : camelCase(v.prop)

        if (prop[0] == '@' && !prop[0].match(/^\s*@(import|namespace|charset)\b/)) {
          obj['$vars'] = obj['$vars'] || {}
          obj['$vars'][prop.slice(1)] = value
          return
        }

        if (prop in obj) {
          arrayKV(obj, prop, value)
        } else {
          obj[prop] = value
        }
    }
  })

  var obj = transformMixin(store)
  const { classes, ids } = nameStore
  if (option.reactNative) {
    const newObj = {}
    for (let k in obj) {
      newObj[k.replace(/^\./, '')] = obj[k]
    }
    obj = newObj
  }
  return option.nameStore
    ? {
        obj,
        classes,
        ids,
      }
    : obj
}

function transformMixin(obj) {
  var $mixins = {}
  for (var k in obj) {
    var arr = parseMixin(k)
    if (arr) {
      obj[k].$vars = obj[k].$vars || {}
      arr[1].forEach(function (v) {
        v = v.split(/[:=]/)
        obj[k].$vars[v[0].replace(/^\s*@/, '')] = (v[1] || '').trim()
      })
      $mixins[arr[0]] = obj[k]
      delete obj[k]
    }
  }
  if (Object.keys($mixins).length) obj.$mixins = $mixins
  return obj
}

function arrayKV(obj, k, v, reverse, unique) {
  obj[k] = k in obj ? [].concat(obj[k]) : []
  if (unique && obj[k].indexOf(v) > -1) return
  reverse ? obj[k].unshift(v) : obj[k].push(v)
}

// css str to obj
export default convertObj