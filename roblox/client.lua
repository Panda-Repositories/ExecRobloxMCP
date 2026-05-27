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

local decompile_fn = (rawget(getfenv(), "decompile") or decompile or (syn and syn.decompile))
local hookmetamethod_fn = (rawget(getfenv(), "hookmetamethod") or hookmetamethod)
local getrawmetatable_fn = (rawget(getfenv(), "getrawmetatable") or getrawmetatable)
local setreadonly_fn = (rawget(getfenv(), "setreadonly") or setreadonly)
local newcclosure_fn = (rawget(getfenv(), "newcclosure") or newcclosure or function(f) return f end)
local getnamecallmethod_fn = (rawget(getfenv(), "getnamecallmethod") or getnamecallmethod)

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

local function resolvePathFull(path)
    if not path or path == "" then return game end
    local cur = game
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

local function equippedTool(char)
    if not char then return nil end
    for _, c in ipairs(char:GetChildren()) do
        if c:IsA("Tool") then return c.Name end
    end
    return nil
end

local function flattenArg(v, depth)
    depth = depth or 0
    if depth > 5 then return "<too deep>" end
    local t = typeof(v)
    if t == "Instance" then
        return { __type = "Instance", path = v:GetFullName(), class = v.ClassName }
    elseif t == "Vector3" then
        return { __type = "Vector3", x = v.X, y = v.Y, z = v.Z }
    elseif t == "Vector2" then
        return { __type = "Vector2", x = v.X, y = v.Y }
    elseif t == "CFrame" then
        return { __type = "CFrame", pos = { v.X, v.Y, v.Z } }
    elseif t == "Color3" then
        return { __type = "Color3", r = v.R, g = v.G, b = v.B }
    elseif t == "EnumItem" then
        return { __type = "EnumItem", name = tostring(v) }
    elseif t == "BrickColor" then
        return { __type = "BrickColor", name = v.Name }
    elseif t == "table" then
        local o = {}
        local n = 0
        for k, val in pairs(v) do
            n = n + 1
            if n > 50 then o.__truncated = true; break end
            o[tostring(k)] = flattenArg(val, depth + 1)
        end
        return o
    elseif t == "string" or t == "number" or t == "boolean" or t == "nil" then
        return v
    else
        return { __type = t, str = tostring(v) }
    end
end

local function flattenArgList(args)
    local out = {}
    for i = 1, select("#", table.unpack(args)) do
        out[i] = flattenArg(args[i])
    end
    return out
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

actions.dry_run_lua = function(msg)
    local fn, err = loadstring(msg.code)
    if not fn then return true, { ok = false, error = tostring(err) } end
    return true, { ok = true }
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
        tool_equipped = equippedTool(char),
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

actions.query_instances = function(msg)
    local root
    if msg.root_path then
        root = resolvePathFull(msg.root_path)
        if not root then return false, "root_path not found" end
    else
        root = game
    end
    local max = msg.max or 100
    local nameMatch = msg.name_match and string.lower(msg.name_match) or nil
    local out = {}
    for _, inst in ipairs(root:GetDescendants()) do
        local pass = true
        if pass and nameMatch and not string.find(string.lower(inst.Name), nameMatch, 1, true) then pass = false end
        if pass and msg.class_name and inst.ClassName ~= msg.class_name then pass = false end
        if pass and msg.is_a then
            local okIs, isInst = pcall(function() return inst:IsA(msg.is_a) end)
            if not okIs or not isInst then pass = false end
        end
        if pass and msg.has_attribute then
            local okA, attrs = pcall(function() return inst:GetAttributes() end)
            if not okA or attrs[msg.has_attribute] == nil then pass = false end
        end
        if pass then
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
    if msg.path then target = resolvePathFull(msg.path) or resolvePath(msg.path)
    elseif msg.name then
        for _, inst in ipairs(Workspace:GetDescendants()) do
            if inst.Name == msg.name then target = inst; break end
        end
    end
    if not target then return false, "instance not found" end
    local path = instancePath(target); target:Destroy()
    return true, { destroyed = path }
end

actions.decompile_script = function(msg)
    if not decompile_fn then return false, "executor does not expose `decompile`" end
    local inst = resolvePathFull(msg.path)
    if not inst then return false, "instance not found" end
    if not (inst:IsA("LocalScript") or inst:IsA("ModuleScript") or inst:IsA("Script")) then
        return false, "instance is not a script: " .. inst.ClassName
    end
    local ok, src = pcall(decompile_fn, inst)
    if not ok then return false, "decompile failed: " .. tostring(src) end
    if type(src) ~= "string" then return false, "decompile returned non-string" end
    return true, { path = instancePath(inst), class = inst.ClassName, source = src, length = #src }
end

actions.list_remotes = function(msg)
    local root = msg.root_path and resolvePathFull(msg.root_path) or game
    if not root then return false, "root_path not found" end
    local include_bindables = msg.include_bindables ~= false
    local max = msg.max or 500
    local out = {}
    for _, inst in ipairs(root:GetDescendants()) do
        local cls = inst.ClassName
        local match = cls == "RemoteEvent" or cls == "RemoteFunction" or cls == "UnreliableRemoteEvent"
        if not match and include_bindables then
            match = cls == "BindableEvent" or cls == "BindableFunction"
        end
        if match then
            table.insert(out, { name = inst.Name, class = cls, path = instancePath(inst) })
            if #out >= max then break end
        end
    end
    return true, out
end

actions.fire_remote = function(msg)
    local inst = resolvePathFull(msg.path)
    if not inst then return false, "remote not found" end
    local args = msg.args or {}
    local cls = inst.ClassName

    if msg.invoke then
        if cls == "RemoteFunction" then
            local ok, results = pcall(function() return { inst:InvokeServer(table.unpack(args)) } end)
            if not ok then return false, tostring(results) end
            return true, { returned = flattenArgList(results) }
        elseif cls == "BindableFunction" then
            local ok, results = pcall(function() return { inst:Invoke(table.unpack(args)) } end)
            if not ok then return false, tostring(results) end
            return true, { returned = flattenArgList(results) }
        else
            return false, "invoke requires RemoteFunction or BindableFunction, got " .. cls
        end
    else
        if cls == "RemoteEvent" or cls == "UnreliableRemoteEvent" then
            local ok, err = pcall(function() inst:FireServer(table.unpack(args)) end)
            if not ok then return false, tostring(err) end
        elseif cls == "BindableEvent" then
            local ok, err = pcall(function() inst:Fire(table.unpack(args)) end)
            if not ok then return false, tostring(err) end
        else
            return false, "not a fireable type: " .. cls
        end
        return true, { fired = true, path = instancePath(inst), class = cls }
    end
end

local spyEnabled = false
local spyBuffer = {}
local spyMax = 200
local spyHookInstalled = false
local spyOriginalNamecall = nil

local function installSpyHook()
    if spyHookInstalled then return true end
    if not (hookmetamethod_fn and getrawmetatable_fn and newcclosure_fn and getnamecallmethod_fn) then
        return false, "executor lacks hookmetamethod / getrawmetatable / newcclosure / getnamecallmethod"
    end
    local ok, err = pcall(function()
        spyOriginalNamecall = hookmetamethod_fn(game, "__namecall", newcclosure_fn(function(self, ...)
            if spyEnabled then
                local okType = pcall(function() return typeof(self) end)
                if okType and typeof(self) == "Instance" then
                    local method = getnamecallmethod_fn()
                    local cls = self.ClassName
                    if (method == "FireServer" or method == "InvokeServer"
                        or method == "Fire" or method == "Invoke"
                        or method == "fireServer")
                        and (cls == "RemoteEvent" or cls == "RemoteFunction"
                             or cls == "BindableEvent" or cls == "BindableFunction"
                             or cls == "UnreliableRemoteEvent")
                    then
                        local args = { ... }
                        local entry = {
                            ts = os.time(),
                            path = self:GetFullName(),
                            method = method,
                            class = cls,
                            args = flattenArgList(args),
                        }
                        table.insert(spyBuffer, entry)
                        if #spyBuffer > spyMax then table.remove(spyBuffer, 1) end
                    end
                end
            end
            return spyOriginalNamecall(self, ...)
        end))
    end)
    if not ok then return false, "hook failed: " .. tostring(err) end
    spyHookInstalled = true
    return true
end

actions.start_remote_spy = function(msg)
    spyMax = msg.max_buffer or 200
    local ok, err = installSpyHook()
    if not ok then return false, err end
    spyEnabled = true
    return true, { enabled = true, max_buffer = spyMax, buffered = #spyBuffer }
end

actions.stop_remote_spy = function()
    spyEnabled = false
    return true, { stopped = true, note = "hook stays installed but is gated; restart with start_remote_spy" }
end

actions.get_remote_log = function(msg)
    local limit = msg.limit or 100
    local filter = msg.path_match and string.lower(msg.path_match) or nil
    local out = {}
    local startIdx = math.max(1, #spyBuffer - limit + 1)
    for i = startIdx, #spyBuffer do
        local e = spyBuffer[i]
        if filter then
            if string.find(string.lower(e.path), filter, 1, true) then table.insert(out, e) end
        else
            table.insert(out, e)
        end
    end
    return true, out
end

actions.clear_remote_log = function()
    spyBuffer = {}
    return true, { cleared = true }
end

actions.snapshot_state = function(msg)
    local root
    if msg.root_path and msg.root_path ~= "" then
        root = resolvePathFull(msg.root_path)
    else
        root = Workspace
    end
    if not root then return false, "root not found" end
    local max = msg.max or 2000
    local out = {}
    for _, inst in ipairs(root:GetDescendants()) do
        if #out >= max then break end
        local entry = { path = instancePath(inst), class = inst.ClassName, name = inst.Name }
        if inst:IsA("BasePart") then
            entry.position = vec3(inst.Position)
        end
        table.insert(out, entry)
    end
    return true, out
end

actions.describe_view = function(msg)
    local cam = Workspace.CurrentCamera
    if not cam then return false, "no camera" end

    local viewport = cam.ViewportSize
    local camPos   = cam.CFrame.Position
    local maxDist  = msg.max_distance or 200
    local maxParts = msg.max_parts or 50
    local includeUi = msg.include_ui ~= false

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
        ui_visible = {},
    }

    for _, p in ipairs(Players:GetPlayers()) do
        local char = p.Character
        local hrp  = char and char:FindFirstChild("HumanoidRootPart")
        local hum  = char and char:FindFirstChildOfClass("Humanoid")
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
                team      = p.Team and p.Team.Name or nil,
                team_color = p.TeamColor and p.TeamColor.Name or nil,
                health    = hum and hum.Health or nil,
                max_health = hum and hum.MaxHealth or nil,
                tool_equipped = equippedTool(char),
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

    if includeUi and LocalPlayer then
        local pg = LocalPlayer:FindFirstChildOfClass("PlayerGui")
        if pg then
            for _, inst in ipairs(pg:GetDescendants()) do
                if #result.ui_visible >= 40 then break end
                if (inst:IsA("TextLabel") or inst:IsA("TextButton") or inst:IsA("TextBox")) and inst.Visible then
                    local txt = inst.Text
                    if txt and txt ~= "" then
                        local pos = inst.AbsolutePosition
                        local sz = inst.AbsoluteSize
                        table.insert(result.ui_visible, {
                            text  = string.sub(txt, 1, 200),
                            class = inst.ClassName,
                            path  = instancePath(inst),
                            pos   = { x = pos.X, y = pos.Y },
                            size  = { x = sz.X, y = sz.Y },
                        })
                    end
                end
            end
        end
    end

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
