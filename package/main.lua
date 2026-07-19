local previous = rawget(_G, "SMTC_MUSIC_APP")
if previous and previous.stop then
  pcall(function() previous.stop("reload") end)
end

local APP_DIR = "/sd/apps/smtc_music"
if file and file.exists and not file.exists(APP_DIR .. "/config.lua") then
  local candidates = { "smtc_music/package", "smtc_music" }
  for _, dir in ipairs(candidates) do
    if file.exists(dir .. "/config.lua") then APP_DIR = dir; break end
  end
end

local config = dofile(APP_DIR .. "/config.lua")
local JSON = rawget(_G, "sjson") or rawget(_G, "json")
local MAIN = (rawget(_G, "LV_PART_MAIN") or 0) | (rawget(_G, "LV_STATE_DEFAULT") or 0)
local FONT_10 = rawget(_G, "LV_FONT_MONTSERRAT_10") or 10
local FONT_12 = rawget(_G, "LV_FONT_MONTSERRAT_12") or 12
local FONT_16 = rawget(_G, "LV_FONT_MONTSERRAT_16") or 16
local FONT_20 = rawget(_G, "LV_FONT_MONTSERRAT_20") or 20
local ALIGN_CENTER = rawget(_G, "LV_TEXT_ALIGN_CENTER") or 1
local ALIGN_RIGHT = rawget(_G, "LV_TEXT_ALIGN_RIGHT") or 2
local LONG_SCROLL = rawget(_G, "LV_LABEL_LONG_SCROLL_CIRCULAR") or rawget(_G, "LV_LABEL_LONG_SCROLL") or 3
local LONG_CLIP = rawget(_G, "LV_LABEL_LONG_CLIP") or 2
local LEFT_X, RIGHT_X = 12, 128
local COVER_X, COVER_Y, COVER_SIZE = 14, 34, 88
local LYRIC_X, LYRIC_Y, LYRIC_W = RIGHT_X, 20, 184
local LYRIC_CENTER_Y = 92
local LYRIC_ACTIVE_LINE_H = 18
local LYRIC_SMALL_LINE_H = 14
local LYRIC_LINE_SPACE = 4
local LYRIC_OFFSETS = { -2, -1, 0, 1, 2 }
local INFO_SCROLL_SPEED = 12

local C = {
  bg = 0x000000,
  panel = 0x141414,
  line = 0x2C2C2E,
  text = 0xF7FAFC,
  sub = 0xA1A1A6,
  dim = 0x636366,
  accent = 0xFF2D55,
  green = 0x30D158,
  warn = 0xFFD60A,
  red = 0xFF453A,
}

local APP = {
  timer = nil,
  control_timer = nil,
  ui_timer = nil,
  running = true,
  inflight = false,
  cover_inflight = false,
  cover_key = "",
  lyric_inflight = false,
  lyric_key = "",
  lyrics = {},
  lyric_idx = 1,
  last_seen = 0,
  sync_position_ms = 0,
  sync_duration_ms = 0,
  sync_at_ms = 0,
  playback_state = "unknown",
  scroll = 0,
  data = nil,
  ui = {},
  font = nil,
}
_G.SMTC_MUSIC_APP = APP

local function log(...)
  if config.serial_log ~= false then print("[smtc_music]", ...) end
end

local function now_ms()
  if millis then
    local ok, value = pcall(millis)
    if ok and type(value) == "number" then return value end
  end
  if tmr and tmr.now then
    local ok, value = pcall(function() return tmr.now() end)
    if ok and type(value) == "number" then return math.floor(value / 1000) end
  end
  return 0
end

local function text_or(value, fallback)
  if value == nil then return fallback or "" end
  local text = tostring(value)
  if text == "" then return fallback or "" end
  return text
end

local function set_text(id, text)
  if id then pcall(function() lv_label_set_text(id, tostring(text or "")) end) end
end

local function set_color(id, color)
  if id then pcall(function() lv_obj_set_style_text_color(id, color, MAIN) end) end
end

local function label(parent, x, y, w, font, color, align, long_mode)
  local id = lv_label_create(parent)
  lv_obj_set_pos(id, x, y)
  lv_obj_set_width(id, w)
  lv_obj_set_style_text_color(id, color or C.text, MAIN)
  lv_obj_set_style_text_font(id, font or FONT_12, MAIN)
  if align and lv_obj_set_style_text_align then lv_obj_set_style_text_align(id, align, MAIN) end
  if lv_label_set_long_mode then lv_label_set_long_mode(id, long_mode or LONG_CLIP) end
  return id
end

local function set_scroll_speed(id, speed)
  if not id then return end
  speed = tonumber(speed) or INFO_SCROLL_SPEED
  if lv_label_set_anim_speed then pcall(function() lv_label_set_anim_speed(id, speed) end) end
  if lv_obj_set_style_anim_speed then pcall(function() lv_obj_set_style_anim_speed(id, speed, MAIN) end) end
end

local function load_font()
  if not lv_font_load then return nil end
  local paths = {
    APP_DIR .. "/font/smtc_cjk_16.bin",
    APP_DIR .. "/font/xiaozhi_common3500_16.bin",
    APP_DIR .. "/font/msyh_cn_13.bin",
    "/sd/apps/mp3_player/font/msyh_cn_13.bin",
    "/sd/apps/weather/font/weather_ui_zh_cn_12.bin",
  }
  for _, path in ipairs(paths) do
    if file and file.exists and file.exists(path) then
      local ok, handle = pcall(lv_font_load, path)
      if ok and type(handle) == "number" and handle > 0 then return handle end
    end
  end
  return nil
end

local function progress_text(pos, dur)
  pos = math.floor((tonumber(pos) or 0) / 1000)
  dur = math.floor((tonumber(dur) or 0) / 1000)
  local function fmt(sec)
    return string.format("%02d:%02d", math.floor(sec / 60), sec % 60)
  end
  if dur > 0 then return fmt(pos) .. " / " .. fmt(dur) end
  return fmt(pos)
end

local function lyric_text(value)
  local text = text_or(value, "")
  text = text:gsub("^%s+", ""):gsub("%s+$", "")
  local left, right = text:match("^(.-)%s+/%s+(.+)$")
  if left and right and left ~= "" and right ~= "" then return left .. "\n" .. right end
  return text
end

local function lyric_utf8_chars(text)
  local chars = {}
  local s = lyric_text(text)
  local i, len = 1, #s
  while i <= len do
    local b = s:byte(i) or 0
    local n = 1
    if b >= 0xF0 then n = 4
    elseif b >= 0xE0 then n = 3
    elseif b >= 0xC0 then n = 2 end
    if i + n - 1 > len then n = 1 end
    chars[#chars + 1] = s:sub(i, i + n - 1)
    i = i + n
  end
  return chars
end

local function lyric_chars_join(chars, first, last)
  local out = {}
  first = math.max(1, first or 1)
  last = math.min(#chars, last or #chars)
  for i = first, last do out[#out + 1] = chars[i] end
  return table.concat(out):gsub("^%s+", ""):gsub("%s+$", "")
end

local function lyric_target_split(total, limit)
  if total <= 0 then return 0 end
  local min_first = math.floor(limit * 2 / 3)
  local split
  if total <= math.floor(limit * 4 / 3) then split = math.floor(total * 0.62 + 0.5)
  else split = math.floor((total + 1) / 2) end
  split = math.max(min_first, split)
  split = math.max(total - limit, split)
  split = math.min(limit, split)
  return split
end

local function wrap_lyric_text(text)
  local prepared = lyric_text(text)
  if prepared:find("\n", 1, true) then return prepared end
  local limit = 11
  local chars = lyric_utf8_chars(prepared)
  local total = #chars
  if total <= limit then return prepared end
  total = math.min(total, limit * 2)
  local target = lyric_target_split(total, limit)
  local best, best_score
  for i = 2, total - 1 do
    local ch = chars[i]
    if ch == " " or ch == "\t" then
      local left, right = i - 1, total - i
      if left > 0 and right > 0 and left <= limit and right <= limit then
        local score = math.abs(left - target)
        if not best_score or score < best_score then best, best_score = i, score end
      end
    end
  end
  if best then
    local first = lyric_chars_join(chars, 1, best - 1)
    local second = lyric_chars_join(chars, best + 1, total)
    if first ~= "" and second ~= "" then return first .. "\n" .. second end
  end
  local split = lyric_target_split(total, limit)
  local first = lyric_chars_join(chars, 1, split)
  local second = lyric_chars_join(chars, split + 1, total)
  if first == "" or second == "" then return lyric_chars_join(chars, 1, total) end
  return first .. "\n" .. second
end

local function lyric_line_count(text)
  local wrapped = wrap_lyric_text(text)
  if wrapped == "" then return 0, wrapped end
  local count, pos = 1, 1
  while true do
    local found = wrapped:find("\n", pos, true)
    if not found then break end
    count = count + 1
    pos = found + 1
  end
  return count, wrapped
end

local function lyric_slot_height(text, active)
  local lines, wrapped = lyric_line_count(text)
  if lines <= 0 then return 0, wrapped end
  local line_h = active and LYRIC_ACTIVE_LINE_H or LYRIC_SMALL_LINE_H
  return lines * line_h + (lines - 1) * LYRIC_LINE_SPACE, wrapped
end

local function lyric_slot_step(slot)
  local h = slot and slot.h or 0
  if h <= 0 then return 0 end
  return h + LYRIC_LINE_SPACE
end

local function lyric_active_y(slot, scroll)
  local h = slot and slot.h or LYRIC_ACTIVE_LINE_H
  if h <= 0 then h = LYRIC_ACTIVE_LINE_H end
  return LYRIC_CENTER_Y - math.floor((h - LYRIC_ACTIVE_LINE_H) / 2) - (scroll or 0)
end

local function lyric_scroll_px(pos, distance)
  local lines = APP.lyrics or {}
  local cur = lines[APP.lyric_idx]
  local next_line = lines[APP.lyric_idx + 1]
  if not cur or not next_line then return 0 end
  local cur_ms = tonumber(cur.at_ms or cur.ms) or 0
  local next_ms = tonumber(next_line.at_ms or next_line.ms) or cur_ms
  pos = tonumber(pos) or 0
  if next_ms <= cur_ms then return 0 end
  local ratio = math.max(0, math.min(1, (pos - cur_ms) / (next_ms - cur_ms)))
  return math.floor(ratio * (tonumber(distance) or (LYRIC_ACTIVE_LINE_H + LYRIC_LINE_SPACE)))
end

local function lyric_text_at(ms)
  local lines = APP.lyrics or {}
  if #lines == 0 then return "", "" end
  if APP.lyric_idx < 1 then APP.lyric_idx = 1 end
  while APP.lyric_idx < #lines and ms >= (tonumber(lines[APP.lyric_idx + 1].at_ms or lines[APP.lyric_idx + 1].ms) or 0) do
    APP.lyric_idx = APP.lyric_idx + 1
  end
  while APP.lyric_idx > 1 and ms < (tonumber(lines[APP.lyric_idx].at_ms or lines[APP.lyric_idx].ms) or 0) do
    APP.lyric_idx = APP.lyric_idx - 1
  end
  local cur = lines[APP.lyric_idx] and lines[APP.lyric_idx].text or ""
  local next_line = lines[APP.lyric_idx + 1] and lines[APP.lyric_idx + 1].text or ""
  return cur, next_line
end

local function status_color(state)
  state = tostring(state or ""):lower()
  if state == "playing" then return C.green end
  if state == "paused" then return C.warn end
  if state == "stopped" then return C.dim end
  return C.red
end

local function draw_bar(pos, dur)
  local fill = APP.ui.fill
  if not fill then return end
  pos, dur = tonumber(pos) or 0, tonumber(dur) or 0
  local w = 0
  local max_w = APP.progress_w or 320
  if dur > 0 then w = math.max(0, math.min(max_w, math.floor(max_w * pos / dur + 0.5))) end
  pcall(function() lv_obj_set_width(fill, w) end)
end

local function current_position_ms()
  local pos = tonumber(APP.sync_position_ms) or 0
  local dur = tonumber(APP.sync_duration_ms) or 0
  local state = tostring(APP.playback_state or ""):lower()
  if state == "playing" then
    pos = pos + math.max(0, now_ms() - (tonumber(APP.sync_at_ms) or 0))
  end
  if dur > 0 then pos = math.max(0, math.min(dur, pos)) end
  return pos
end

local base_url

local function safe_id(value)
  return tostring(value or ""):gsub("[^%w_%-]", "")
end

local function cover_path(ncm_id, ext)
  return APP_DIR .. "/cover_" .. safe_id(ncm_id) .. "." .. (ext or "jpg")
end

local function media_key(provider, id)
  provider = text_or(provider, "")
  id = text_or(id, "")
  if provider == "" or id == "" then return "" end
  return provider .. "_" .. id
end

local function cover_cache_key(provider, id)
  local key = media_key(provider, id)
  if key == "" then return "" end
  return key .. "_fit92"
end

local function status_lyric_ref(data)
  if not data then return "", "", "" end
  local provider = text_or(data.lyric_provider, "")
  local id = text_or(data.lyric_id_text, "")
  if id == "" then
    id = text_or(data.ncm_id_text, "")
    if id == "" then
      local raw = tonumber(data.ncm_id) or 0
      if raw > 0 then id = tostring(math.floor(raw)) end
    end
    if id ~= "" and provider == "" then provider = "netease" end
  end
  return provider, id, media_key(provider, id)
end

local function status_cover_ref(data)
  if not data then return "", "", "" end
  local provider = text_or(data.cover_provider, "")
  local id = text_or(data.cover_id_text, "")
  if id == "" then
    id = text_or(data.ncm_id_text, "")
    if id == "" then
      local raw = tonumber(data.ncm_id) or 0
      if raw > 0 then id = tostring(math.floor(raw)) end
    end
    if id ~= "" and provider == "" then provider = "netease" end
  end
  return provider, id, cover_cache_key(provider, id)
end

local function image_ext_from_bytes(body)
  if type(body) ~= "string" or #body < 4 then return "jpg" end
  local b1, b2, b3, b4 = body:byte(1, 4)
  if b1 == 0x89 and b2 == 0x50 and b3 == 0x4E and b4 == 0x47 then return "png" end
  if b1 == 0xFF and b2 == 0xD8 then return "jpg" end
  return "jpg"
end

local function be16(body, pos)
  local a, b = body:byte(pos, pos + 1)
  if not a or not b then return 0 end
  return a * 256 + b
end

local function be32(body, pos)
  local a, b, c, d = body:byte(pos, pos + 3)
  if not a or not b or not c or not d then return 0 end
  return ((a * 256 + b) * 256 + c) * 256 + d
end

local function image_info_from_bytes(body)
  local ext = image_ext_from_bytes(body)
  local w, h = 0, 0
  if ext == "png" and #body >= 24 then
    w, h = be32(body, 17), be32(body, 21)
  elseif ext == "jpg" and #body > 12 then
    local pos = 3
    while pos + 8 <= #body do
      if body:byte(pos) ~= 0xFF then break end
      local marker = body:byte(pos + 1) or 0
      local len = be16(body, pos + 2)
      if len < 2 then break end
      if marker >= 0xC0 and marker <= 0xC3 then
        h, w = be16(body, pos + 5), be16(body, pos + 7)
        break
      end
      pos = pos + 2 + len
    end
  end
  return ext, w, h
end

local function image_info_from_file(path)
  if not file or not file.getcontents or not path then return nil end
  local ok, body = pcall(function() return file.getcontents(path) end)
  if ok and type(body) == "string" and #body >= 4 then return image_info_from_bytes(body) end
  return nil
end

local function cover_zoom_for(w, h)
  w, h = tonumber(w) or 0, tonumber(h) or 0
  local side = math.max(w, h)
  if side <= 0 then return 245 end
  return math.max(1, math.min(256, math.floor(COVER_SIZE * 256 / side)))
end

local function sd_to_lv(path)
  path = tostring(path or "")
  if path:sub(1, 4) == "/sd/" then
    return "S:/" .. path:sub(5)
  end
  return path
end

local function set_cover_visible(visible)
  if not APP.ui.cover_img or not lv_obj_add_flag or not lv_obj_clear_flag or not rawget(_G, "LV_OBJ_FLAG_HIDDEN") then
    return
  end
  if visible then
    pcall(function() lv_obj_clear_flag(APP.ui.cover_img, rawget(_G, "LV_OBJ_FLAG_HIDDEN")) end)
  else
    pcall(function() lv_obj_add_flag(APP.ui.cover_img, rawget(_G, "LV_OBJ_FLAG_HIDDEN")) end)
  end
end

local function show_cover_file(key)
  if not APP.ui.cover_img or not lv_img_set_src then return false end
  local path = nil
  local exts = { APP.cover_ext, "png", "jpg" }
  for _, ext in ipairs(exts) do
    if ext and ext ~= "" then
      local candidate = cover_path(key, ext)
      if not file or not file.exists or file.exists(candidate) then
        local actual, w, h = image_info_from_file(candidate)
        if not actual or actual == ext then
          path = candidate
          APP.cover_ext = ext
          APP.cover_zoom = cover_zoom_for(w, h)
          break
        end
      end
    end
  end
  if not path then return false end
  local ok = pcall(function() lv_img_set_src(APP.ui.cover_img, sd_to_lv(path)) end)
  if ok then
    APP.cover_key = key
    if lv_obj_set_size then pcall(function() lv_obj_set_size(APP.ui.cover_img, COVER_SIZE, COVER_SIZE) end) end
    if lv_img_set_zoom then pcall(function() lv_img_set_zoom(APP.ui.cover_img, APP.cover_zoom or 245) end) end
    if lv_img_set_antialias then pcall(function() lv_img_set_antialias(APP.ui.cover_img, true) end) end
    set_cover_visible(true)
  end
  return ok
end

local function update_cover(data)
  if not data or not http or not http.get or not file then return end
  if not APP.ui.cover_img or not lv_img_set_src then return end
  local provider, id, key = status_cover_ref(data)
  if key == "" or text_or(data.cover_url, "") == "" then
    set_cover_visible(false)
    return
  end
  if APP.cover_key == key then
    show_cover_file(key)
    return
  end
  if show_cover_file(key) then return end
  if APP.cover_inflight then return end
  APP.cover_inflight = true
  local url = base_url() .. "/cover?provider=" .. tostring(provider) .. "&id=" .. tostring(id)
  http.get(url, { timeout = tonumber(config.timeout_ms) or 5000 }, function(code, body)
    APP.cover_inflight = false
    if not APP.running then return end
    if code == 200 and type(body) == "string" and #body > 128 then
      local ok = false
      local ext, w, h = image_info_from_bytes(body)
      APP.cover_ext = ext
      APP.cover_zoom = cover_zoom_for(w, h)
      if file.putcontents then
        ok = pcall(function() return file.putcontents(cover_path(key, ext), body) end)
      else
        local fd = file.open and file.open(cover_path(key, ext), "w+")
        if fd then
          ok = pcall(function() fd:write(body); fd:close() end)
        end
      end
      if ok then
        show_cover_file(key)
      end
    end
  end)
end

local function set_lyric_slot(slot, text, y, active, opa)
  if not slot then return end
  local h, wrapped = lyric_slot_height(text, active)
  pcall(function() lv_obj_set_pos(slot, LYRIC_X, LYRIC_Y + y) end)
  if lv_obj_set_width then pcall(function() lv_obj_set_width(slot, LYRIC_W) end) end
  if lv_obj_set_height then pcall(function() lv_obj_set_height(slot, math.max(1, h)) end) end
  pcall(function() lv_obj_set_style_text_font(slot, APP.font or FONT_16, MAIN) end)
  pcall(function() lv_obj_set_style_text_color(slot, active and C.text or C.dim, MAIN) end)
  if lv_obj_set_style_text_opa then pcall(function() lv_obj_set_style_text_opa(slot, opa or 255, MAIN) end) end
  if lv_label_set_long_mode then pcall(function() lv_label_set_long_mode(slot, LONG_CLIP) end) end
  set_text(slot, wrapped)
end

local function render_message_lyrics(text)
  if not APP.ui.lyric_labels then return end
  for i, slot in ipairs(APP.ui.lyric_labels) do
    if i == 3 then
      local h = lyric_slot_height(text, true)
      set_lyric_slot(slot, text, lyric_active_y({ h = h }, 0), true, 255)
    else
      set_lyric_slot(slot, "", LYRIC_CENTER_Y + (i - 3) * (LYRIC_SMALL_LINE_H + LYRIC_LINE_SPACE), false, 0)
    end
  end
end

local function render_lyric_window(data, pos)
  if not APP.ui.lyric_labels then return end
  local connected = data and data.ok and data.connected
  if not connected then
    render_message_lyrics("No session")
    return
  end
  local lines = APP.lyrics or {}
  if #lines == 0 then
    render_message_lyrics(data.lyrics_available and "Loading lyrics" or "No lyric loaded")
    return
  end

  pos = tonumber(pos) or 0
  lyric_text_at(pos)
  local slots, active_i = {}, 1
  for i, rel in ipairs(LYRIC_OFFSETS) do
    local active = rel == 0
    local line = lines[APP.lyric_idx + rel]
    local text = line and line.text or ""
    local h = lyric_slot_height(text, active)
    local opa = active and 255 or (math.abs(rel) >= 2 and 120 or 185)
    slots[i] = { text = text, active = active, opa = opa, h = h }
    if active then active_i = i end
  end

  local active_slot = slots[active_i] or { h = LYRIC_ACTIVE_LINE_H }
  active_slot.y = lyric_active_y(active_slot, lyric_scroll_px(pos, lyric_slot_step(active_slot)))
  for i = active_i - 1, 1, -1 do
    slots[i].y = slots[i + 1].y - lyric_slot_step(slots[i])
  end
  for i = active_i + 1, #slots do
    slots[i].y = slots[i - 1].y + lyric_slot_step(slots[i - 1])
  end
  for i, info in ipairs(slots) do
    set_lyric_slot(APP.ui.lyric_labels[i], info.text, info.y, info.active, info.opa)
  end
end

local function render(sync_media)
  local data = APP.data or {}
  local connected = data.ok and data.connected
  local title = connected and text_or(data.title, "Unknown title") or "Waiting for SMTC"
  local artist = connected and text_or(data.artist, "Unknown artist") or ("http://" .. tostring(config.host) .. ":" .. tostring(config.port))
  local album = connected and text_or(data.album, "No album") or "Start smtc-bridge.js on your PC"
  local state = connected and text_or(data.state, "unknown") or "offline"

  set_text(APP.ui.title, title)
  set_text(APP.ui.artist, artist)
  set_text(APP.ui.album, album)
  set_text(APP.ui.state, string.upper(state))
  set_color(APP.ui.state, connected and status_color(state) or C.red)
  local pos = connected and current_position_ms() or 0
  local dur = connected and (tonumber(APP.sync_duration_ms) or tonumber(data.duration_ms) or 0) or 0
  set_text(APP.ui.time, progress_text(pos, dur))
  render_lyric_window(data, pos)
  draw_bar(pos, dur)
  if sync_media then
    if connected then update_cover(data) else set_cover_visible(false) end
  end
end

local function decode(raw)
  if not JSON or not JSON.decode or type(raw) ~= "string" then return nil end
  local ok, value = pcall(JSON.decode, raw)
  return ok and value or nil
end

function base_url()
  return "http://" .. tostring(config.host) .. ":" .. tostring(config.port)
end

local function fetch_lyrics(provider, id)
  provider = text_or(provider, "")
  id = text_or(id, "")
  local key = media_key(provider, id)
  if key == "" or APP.lyric_inflight or not http or not http.get then return end
  if APP.lyric_key == key and #(APP.lyrics or {}) > 0 then return end
  APP.lyric_inflight = true
  local url = base_url() .. "/lyrics?provider=" .. tostring(provider) .. "&id=" .. tostring(id)
  http.get(url, { timeout = tonumber(config.timeout_ms) or 5000 }, function(code, body)
    APP.lyric_inflight = false
    if not APP.running then return end
    if code == 200 then
      local data = decode(body)
      if type(data) == "table" and type(data.lines) == "table" then
        APP.lyric_key = key
        APP.lyrics = data.lines
        APP.lyric_idx = 1
        render(false)
        return
      end
    end
    APP.lyric_key = key
    APP.lyrics = {}
    APP.lyric_idx = 1
    render(false)
  end)
end

local function poll_status()
  if APP.inflight or not http or not http.get then return end
  APP.inflight = true
  local url = base_url() .. tostring(config.status_path or "/status")
  http.get(url, { timeout = tonumber(config.timeout_ms) or 2500 }, function(code, body)
    APP.inflight = false
    if not APP.running then return end
    if code == 200 then
      local data = decode(body)
      if type(data) == "table" then
        APP.data = data
        APP.last_seen = now_ms()
        APP.sync_at_ms = APP.last_seen
        APP.sync_position_ms = tonumber(data.position_ms) or 0
        APP.sync_duration_ms = tonumber(data.duration_ms) or 0
        APP.playback_state = text_or(data.state, "unknown")
        local provider, id, key = status_lyric_ref(data)
        if key ~= "" and key ~= APP.lyric_key then
          APP.lyrics = {}
          APP.lyric_idx = 1
          fetch_lyrics(provider, id)
        elseif key == "" and APP.lyric_key ~= "" then
          APP.lyric_key = ""
          APP.lyrics = {}
          APP.lyric_idx = 1
        end
        render(true)
        return
      end
    end
    APP.data = { ok = false, connected = false, state = "offline" }
    APP.playback_state = "offline"
    render(true)
  end)
end

local function control(action)
  if not http or not http.get then return end
  local url = base_url() .. tostring(config.control_path or "/control") .. "?action=" .. tostring(action)
  http.get(url, { timeout = tonumber(config.timeout_ms) or 2500 }, function(code, body)
    log("control", action, code)
  end)
  if APP.control_timer then
    pcall(function() APP.control_timer:stop() end)
    pcall(function() APP.control_timer:unregister() end)
    APP.control_timer = nil
  end
  if tmr and tmr.create then
    APP.control_timer = tmr.create()
    APP.control_timer:alarm(420, tmr.ALARM_SINGLE or 0, function()
      APP.control_timer = nil
      poll_status()
    end)
  else
    poll_status()
  end
end

local function build_ui()
  APP.font = load_font()
  local root = lv_scr_act()
  if lv_obj_clean then lv_obj_clean(root) end
  lv_obj_set_style_bg_color(root, C.bg, MAIN)
  lv_obj_set_style_bg_opa(root, 255, MAIN)
  if lv_obj_clear_flag and rawget(_G, "LV_OBJ_FLAG_SCROLLABLE") then
    lv_obj_clear_flag(root, rawget(_G, "LV_OBJ_FLAG_SCROLLABLE"))
  end

  local card = root

  APP.ui.state = label(card, LEFT_X, 10, 94, FONT_12, C.warn)
  APP.ui.time = label(card, LEFT_X, 214, 104, FONT_10, C.sub)
  if lv_img_create then
    APP.ui.cover_img = lv_img_create(card)
    lv_obj_set_pos(APP.ui.cover_img, COVER_X, COVER_Y)
    if lv_obj_set_size then lv_obj_set_size(APP.ui.cover_img, COVER_SIZE, COVER_SIZE) end
    set_cover_visible(false)
  end
  APP.ui.title = label(card, LEFT_X, 132, 104, APP.font or FONT_20, C.text, nil, LONG_SCROLL)
  APP.ui.artist = label(card, LEFT_X, 162, 104, APP.font or FONT_16, C.sub, nil, LONG_SCROLL)
  APP.ui.album = label(card, LEFT_X, 188, 104, APP.font or FONT_12, C.dim, nil, LONG_SCROLL)
  set_scroll_speed(APP.ui.title, INFO_SCROLL_SPEED)
  set_scroll_speed(APP.ui.artist, INFO_SCROLL_SPEED)
  set_scroll_speed(APP.ui.album, INFO_SCROLL_SPEED)

  local bar_bg = lv_obj_create(card)
  APP.progress_w = 320
  lv_obj_set_pos(bar_bg, 0, 235)
  lv_obj_set_size(bar_bg, APP.progress_w, 5)
  lv_obj_set_style_bg_color(bar_bg, C.line, MAIN)
  lv_obj_set_style_bg_opa(bar_bg, 255, MAIN)
  lv_obj_set_style_border_width(bar_bg, 0, MAIN)
  lv_obj_set_style_radius(bar_bg, 0, MAIN)
  APP.ui.fill = lv_obj_create(bar_bg)
  lv_obj_set_pos(APP.ui.fill, 0, 0)
  lv_obj_set_size(APP.ui.fill, 0, 5)
  lv_obj_set_style_bg_color(APP.ui.fill, C.accent, MAIN)
  lv_obj_set_style_bg_opa(APP.ui.fill, 255, MAIN)
  lv_obj_set_style_border_width(APP.ui.fill, 0, MAIN)
  lv_obj_set_style_radius(APP.ui.fill, 0, MAIN)

  APP.ui.lyric_labels = {}
  for i = 1, 5 do
    APP.ui.lyric_labels[i] = label(card, LYRIC_X, LYRIC_Y + LYRIC_CENTER_Y + (i - 3) * (LYRIC_SMALL_LINE_H + LYRIC_LINE_SPACE), LYRIC_W, APP.font or FONT_16, C.dim, ALIGN_CENTER, LONG_CLIP)
  end
  render()
end

local function bind_keys()
  if not key or not key.on then return end
  if app and app.set_home_exit then pcall(function() app.set_home_exit(false) end) end
  key.on(key.LEFT, function(evt) if evt == key.SHORT then control("previous") end end)
  key.on(key.RIGHT, function(evt) if evt == key.SHORT then control("next") end end)
  key.on(key.HOME, function(evt)
    if evt == key.SHORT then control("playpause")
    elseif evt == key.LONG_START or evt == key.EXIT then
      APP.stop("exit")
      if app and app.exit then app.exit() end
    end
  end)
  if key.UP then key.on(key.UP, function(evt) if evt == key.SHORT then control("seek_forward") end end) end
  if key.DOWN then key.on(key.DOWN, function(evt) if evt == key.SHORT then control("seek_back") end end) end
end

function APP.stop(reason)
  if not APP.running then return end
  APP.running = false
  if APP.timer then pcall(function() APP.timer:stop() end); pcall(function() APP.timer:unregister() end); APP.timer = nil end
  if APP.ui_timer then pcall(function() APP.ui_timer:stop() end); pcall(function() APP.ui_timer:unregister() end); APP.ui_timer = nil end
  if APP.control_timer then pcall(function() APP.control_timer:stop() end); pcall(function() APP.control_timer:unregister() end); APP.control_timer = nil end
  if key and key.off then pcall(key.off) end
  if app and app.set_home_exit then pcall(function() app.set_home_exit(true) end) end
  if APP.font and lv_font_free then pcall(lv_font_free, APP.font) end
  APP.font = nil
end

build_ui()
bind_keys()
poll_status()
if tmr and tmr.create then
  APP.timer = tmr.create()
  APP.timer:alarm(tonumber(config.poll_ms) or 1000, tmr.ALARM_AUTO, poll_status)
  APP.ui_timer = tmr.create()
  APP.ui_timer:alarm(120, tmr.ALARM_AUTO, function()
    if APP.running then render(false) end
  end)
end
