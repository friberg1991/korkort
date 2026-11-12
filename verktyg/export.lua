-- Exports Emils Körkort's chapters, questions and signs for the phone app.
--   lua verktyg/export.lua <EmilsKorkort folder> <out data.js>
-- Run in the AddOns folder: lua C:/Users/Emil/korkort/verktyg/export.lua EmilsKorkort
-- C:/Users/Emil/korkort/data.js
-- Questions on the book's photos (p31, p31b) are left out: the photos belong
-- to the book's publisher and the app is public. The sign questions are
-- built by the app itself from the sign list, as the addon does.

local dir, out = ...
assert(dir and out, "usage: lua export.lua <EmilsKorkort folder> <out data.js>")

local ns = {}
for _, file in ipairs({ "Questions.lua", "Signs.lua" }) do
    local chunk = assert(loadfile(dir .. "/" .. file))
    chunk("EmilsKorkort", ns)
end

local function str(s)
    s = s:gsub('[%c"\\]', function(c)
        if c == "\n" then return "\\n" end
        if c == '"' or c == "\\" then return "\\" .. c end
        return ("\\u%04x"):format(c:byte())
    end)
    return '"' .. s .. '"'
end

local function list(t, each)
    local parts = {}
    for i, v in ipairs(t) do parts[i] = each(v) end
    return "[" .. table.concat(parts, ",") .. "]"
end

local chapters = list(ns.CHAPTERS, function(c)
    return ("[%s,%s,%s]"):format(str(c.key), str(c.name), c.pictures and "true" or "false")
end)

local kept, dropped = {}, 0
for _, q in ipairs(ns.QUESTIONS) do
    if q[5] and q[5]:match("^p%d") then
        dropped = dropped + 1
    else
        kept[#kept + 1] = q
    end
end

local questions = list(kept, function(q)
    return ("[%s,%s,%s,%s,%s]"):format(str(q[1]), str(q[2]), list(q[3], str), str(q[4]),
        q[5] and str(q[5]) or "null")
end)

local signs = list(ns.SIGNS, function(s) return ("[%s,%s]"):format(str(s[1]), str(s[2])) end)

local f = assert(io.open(out, "wb"))
f:write("// Made by verktyg/export.lua from Emils Körkort. Do not edit.\n")
f:write("window.KORKORT = {\n")
f:write("chapters: ", chapters, ",\n")
f:write("questions: ", questions, ",\n")
f:write("signs: ", signs, "\n")
f:write("};\n")
f:close()
print(("%d questions (%d on book photos left out), %d signs"):format(#kept, dropped, #ns.SIGNS))
