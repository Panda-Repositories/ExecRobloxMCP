local WS_URL = "ws://localhost:8767"

local Players       = game:GetService("Players")
local Workspace     = game:GetService("Workspace")
local LogService    = game:GetService("LogService")
local HttpService   = game:GetService("HttpService")
local RunService    = game:GetService("RunService")
local CaptureService = pcall(function() return game:GetService("CaptureService") end) and game:GetService("CaptureService") or nil

local LocalPlayer = Players.LocalPlayer

local function wsConnect(url)
    if syn and syn.websocket and syn.websocket.connect then return syn.websocket.connect(url) end
    if WebSocket and WebSocket.connect then return WebSocket.connect(url) end
    if Krnl and Krnl.WebSocket and Krnl.WebSocket.connect then return Krnl.WebSocket.connect(url) end
    error("No WebSocket API found in this executor")
end

local writefile_fn = (rawget(getfenv(), "writefile") or writefile)
local readfile_fn  = (rawget(getfenv(), "readfile")  or readfile)
local isfile_fn    = (rawget(getfenv(), "isfile")    or isfile)
local getcustomasset_fn = (rawget(getfenv(), "getcustomasset") or getcustomasset or (syn and syn.getcustomasset) or getsynasset)

local function b64encode(data)
    local b = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    return ((data:gsub('.', function(x)
        local r, byte = '', x:byte()
        for i = 8, 1, -1 do r = r .. (byte % 2^i - byte % 2^(i-1) > 0 and '1' or '0') end
        return r
    end) .. '0000'):gsub('%d%d%d?%d?%d?%d?', function(x)
        if #x < 6 then return '' end
        local c = 0
        for i = 1, 6 do c = c + (x:sub(i,i) == '1' and 2^(6-i) or 0) end
        return b:sub(c+1, c+1)
    end) .. ({ '', '==', '=' })[#data % 3 + 1])
end

local function vec3(v) return { x = v.X, y = v.Y, z = v.Z } end

local function findPlayer(name)
    if not name then return nil end
    name = string.lower(name)
    for _, p in ipairs(Players:GetPlayers()) do
        if string.lower(p.Name) == name or string.lower(p.DisplayName) == name then return p end
    end
    return nil
end

local function instancePath(inst)
    local parts, cur = {}, inst
    while cur and cur ~= game do
        table.insert(parts, 1, cur.Name); cur = cur.Parent
    end
    return table.concat(parts, ".")
end

local function resolvePath(path)
    if not path or path == "" then return Workspace end
    local cur = Workspace
    for part in string.gmatch(path, "[^.]+") do
        cur = cur:FindFirstChild(part); if not cur then return nil end
    end
    return cur
end

local function partInfo(inst)
    local info = { name = inst.Name, class = inst.ClassName, path = instancePath(inst) }
    if inst:IsA("BasePart") then
        info.position = vec3(inst.Position)
        info.size = vec3(inst.Size)
        info.anchored = inst.Anchored
    end
    return info
end

local function hexToColor3(hex)
    hex = string.gsub(hex, "#", "")
    if #hex ~= 6 then return nil end
    return Color3.fromRGB(
        tonumber(string.sub(hex,1,2),16) or 0,
        tonumber(string.sub(hex,3,4),16) or 0,
        tonumber(string.sub(hex,5,6),16) or 0)
end

local currentWs = nil
local function send(tbl)
    if not currentWs then return end
    local ok, json = pcall(HttpService.JSONEncode, HttpService, tbl)
    if ok then pcall(function() currentWs:Send(json) end) end
end

local function reply(id, ok, data)
    if ok then send({ id = id, ok = true, result = data })
    else      send({ id = id, ok = false, error = tostring(data) }) end
end

local actions = {}

actions.exec = function(msg)
    local fn, err = loadstring(msg.code)
    if not fn then return false, "compile: " .. tostring(err) end
    local results = { pcall(fn) }
    local ok = table.remove(results, 1)
    if not ok then return false, results[1] end
    if #results == 0 then return true, nil end
    if #results == 1 then return true, results[1] end
    return true, results
end

actions.get_players = function()
    local list = {}
    for _, p in ipairs(Players:GetPlayers()) do
        local hum = p.Character and p.Character:FindFirstChildOfClass("Humanoid")
        table.insert(list, {
            name = p.Name, display_name = p.DisplayName, user_id = p.UserId,
            team = p.Team and p.Team.Name or nil,
            health = hum and hum.Health or nil, max_health = hum and hum.MaxHealth or nil,
            is_local = (p == LocalPlayer),
        })
    end
    return true, list
end

actions.get_player_info = function(msg)
    local p = findPlayer(msg.name)
    if not p then return false, "player not found" end
    local char = p.Character
    local hrp  = char and char:FindFirstChild("HumanoidRootPart")
    local hum  = char and char:FindFirstChildOfClass("Humanoid")
    return true, {
        name = p.Name, display_name = p.DisplayName, user_id = p.UserId,
        account_age = p.AccountAge,
        team = p.Team and p.Team.Name or nil,
        health = hum and hum.Health or nil, max_health = hum and hum.MaxHealth or nil,
        walk_speed = hum and hum.WalkSpeed or nil,
        position = hrp and vec3(hrp.Position) or nil,
        in_character = char ~= nil,
    }
end

actions.teleport_player = function(msg)
    local p = findPlayer(msg.name); if not p then return false, "player not found" end
    local char = p.Character; local hrp = char and char:FindFirstChild("HumanoidRootPart")
    if not hrp then return false, "no HumanoidRootPart" end
    if msg.to_player then
        local t = findPlayer(msg.to_player); if not t or not t.Character then return false, "target missing" end
        local thrp = t.Character:FindFirstChild("HumanoidRootPart")
        if not thrp then return false, "target has no HRP" end
        hrp.CFrame = thrp.CFrame + Vector3.new(0, 3, 0)
    else
        hrp.CFrame = CFrame.new(msg.x or hrp.Position.X, msg.y or hrp.Position.Y, msg.z or hrp.Position.Z)
    end
    return true, { ok = true }
end

actions.kick_player = function(msg)
    local p = findPlayer(msg.name); if not p then return false, "player not found" end
    local ok, err = pcall(function() p:Kick(msg.reason or "kicked") end)
    if not ok then return false, err end
    return true, { ok = true }
end

actions.get_workspace_children = function(msg)
    local root = resolvePath(msg.path); if not root then return false, "path not found" end
    local max = msg.max or 100; local out = {}
    for i, child in ipairs(root:GetChildren()) do
        if i > max then break end
        table.insert(out, partInfo(child))
    end
    return true, out
end

actions.find_parts = function(msg)
    local max = msg.max or 50
    local nameMatch = msg.name_match and string.lower(msg.name_match) or nil
    local className = msg.class_name
    local out = {}
    for _, inst in ipairs(Workspace:GetDescendants()) do
        local nameOk  = (not nameMatch) or string.find(string.lower(inst.Name), nameMatch, 1, true) ~= nil
        local classOk = (not className) or inst.ClassName == className
        if nameOk and classOk then
            table.insert(out, partInfo(inst))
            if #out >= max then break end
        end
    end
    return true, out
end

actions.spawn_part = function(msg)
    local part = Instance.new("Part")
    part.Name = msg.name or "MCP_Part"
    part.Position = Vector3.new(msg.x, msg.y, msg.z)
    part.Size = Vector3.new(msg.size_x or 4, msg.size_y or 1, msg.size_z or 4)
    part.Anchored = msg.anchored ~= false
    if msg.color then
        local c3 = hexToColor3(msg.color)
        if c3 then part.Color = c3
        else
            local ok, bc = pcall(BrickColor.new, msg.color)
            if ok then part.BrickColor = bc end
        end
    end
    part.Parent = Workspace
    return true, partInfo(part)
end

actions.destroy_instance = function(msg)
    local target
    if msg.path then target = resolvePath(msg.path)
    elseif msg.name then
        for _, inst in ipairs(Workspace:GetDescendants()) do
            if inst.Name == msg.name then target = inst; break end
        end
    end
    if not target then return false, "instance not found" end
    local path = instancePath(target); target:Destroy()
    return true, { destroyed = path }
end

actions.describe_view = function(msg)
    local cam = Workspace.CurrentCamera
    if not cam then return false, "no camera" end

    local viewport = cam.ViewportSize
    local camPos   = cam.CFrame.Position
    local maxDist  = msg.max_distance or 200
    local maxParts = msg.max_parts or 50

    local result = {
        camera = {
            position    = vec3(camPos),
            look_vector = vec3(cam.CFrame.LookVector),
            up_vector   = vec3(cam.CFrame.UpVector),
            fov         = cam.FieldOfView,
            viewport    = { x = viewport.X, y = viewport.Y },
        },
        players = {},
        nearby_parts = {},
    }

    for _, p in ipairs(Players:GetPlayers()) do
        local char = p.Character
        local hrp  = char and char:FindFirstChild("HumanoidRootPart")
        if hrp then
            local sp, onScreen = cam:WorldToViewportPoint(hrp.Position)
            local dist = (hrp.Position - camPos).Magnitude

            local rayParams = RaycastParams.new()
            rayParams.FilterDescendantsInstances = { char, LocalPlayer and LocalPlayer.Character or nil }
            rayParams.FilterType = Enum.RaycastFilterType.Exclude
            local ray = Workspace:Raycast(camPos, hrp.Position - camPos, rayParams)

            table.insert(result.players, {
                name      = p.Name,
                distance  = dist,
                screen    = { x = sp.X, y = sp.Y, depth = sp.Z },
                on_screen = onScreen,
                occluded  = ray ~= nil,
                is_local  = p == LocalPlayer,
            })
        end
    end

    local box = CFrame.new(camPos)
    local size = Vector3.new(maxDist * 2, maxDist * 2, maxDist * 2)
    local params = OverlapParams.new()
    params.MaxParts = maxParts * 4
    local hits = Workspace:GetPartBoundsInBox(box, size, params)

    for _, part in ipairs(hits) do
        if #result.nearby_parts >= maxParts then break end
        local isCharPart = part.Parent and part.Parent:FindFirstChildOfClass("Humanoid")
        if not isCharPart then
            local sp, onScreen = cam:WorldToViewportPoint(part.Position)
            if sp.Z > 0 then
                table.insert(result.nearby_parts, {
                    name      = part.Name,
                    class     = part.ClassName,
                    path      = instancePath(part),
                    distance  = (part.Position - camPos).Magnitude,
                    on_screen = onScreen,
                    screen    = { x = sp.X, y = sp.Y, depth = sp.Z },
                })
            end
        end
    end

    table.sort(result.nearby_parts, function(a, b) return a.distance < b.distance end)
    return true, result
end

actions.capture_screenshot = function()
    if not CaptureService or not CaptureService.CaptureScreenshot then
        return false, "CaptureService.CaptureScreenshot not available on this client"
    end

    local done, contentId = false, nil
    CaptureService:CaptureScreenshot(function(id)
        contentId = id; done = true
    end)

    local t0 = tick()
    while not done and tick() - t0 < 8 do task.wait(0.05) end
    if not done then return false, "capture timed out" end

    local result = { content_id = contentId }

    if CaptureService.SaveScreenshotAsync and writefile_fn then
        local rel = "mcp_screenshot.png"
        local ok = pcall(function()
            CaptureService:SaveScreenshotAsync(contentId, { Path = rel })
        end)
        if ok and readfile_fn and isfile_fn and isfile_fn(rel) then
            local ok2, raw = pcall(readfile_fn, rel)
            if ok2 and raw then
                result.image_base64 = b64encode(raw)
                result.mime_type    = "image/png"
            end
        end
    end

    if not result.image_base64 then
        result.note = "Image bytes unavailable on this executor. Pair with describe_view for vision."
    end
    return true, result
end

local logConn = nil
local function installHandlers(ws)
    ws.OnMessage:Connect(function(raw)
        local ok, msg = pcall(HttpService.JSONDecode, HttpService, raw)
        if not ok or type(msg) ~= "table" then return end
        local fn = actions[msg.action]
        if not fn then
            reply(msg.id, false, "unknown action: " .. tostring(msg.action))
            return
        end
        local success, result, payload = pcall(fn, msg)
        if not success then reply(msg.id, false, "runtime: " .. tostring(result))
        else                 reply(msg.id, result, payload) end
    end)

    if logConn then logConn:Disconnect() end
    local LEVEL_MAP = {
        [Enum.MessageType.MessageOutput]  = "info",
        [Enum.MessageType.MessageInfo]    = "info",
        [Enum.MessageType.MessageWarning] = "warn",
        [Enum.MessageType.MessageError]   = "error",
    }
    logConn = LogService.MessageOut:Connect(function(message, msgType)
        send({ event = "log", level = LEVEL_MAP[msgType] or "info", message = message })
    end)
    for _, entry in ipairs(LogService:GetLogHistory()) do
        send({ event = "log", level = LEVEL_MAP[entry.messageType] or "info", message = entry.message })
    end
end

local function connectOnce()
    local ok, ws = pcall(wsConnect, WS_URL)
    if not ok or not ws then return nil, tostring(ws) end
    return ws
end

task.spawn(function()
    local backoff = 1
    while true do
        local ws, err = connectOnce()
        if not ws then
            warn(("[mcp-bridge] connect failed: %s — retry in %ds"):format(err or "?", backoff))
        else
            currentWs = ws
            print("[mcp-bridge] connected to " .. WS_URL)

            installHandlers(ws)

            local closed = false
            ws.OnClose:Connect(function() closed = true end)
            while not closed do task.wait(0.5) end

            currentWs = nil
            warn("[mcp-bridge] disconnected")
            backoff = 1
        end
        task.wait(backoff)
        backoff = math.min(backoff * 2, 30)
    end
end)

print("[mcp-bridge] client loaded, connecting…")
