local Client_API = "b3df6d8ad0d1f314d3eb4f7d4177a0fb172f3c6320d8af89008816225529ade8"
local Keep_Reconnecting = true
local Anti_AFK = true

local Server_IP = "10.168.0.100"
local Server_WS_Ports = { 8765, 8767 }

local WS_URLS = {}
for _, p in ipairs(Server_WS_Ports) do
    table.insert(WS_URLS, "ws://" .. Server_IP .. ":" .. p)
end
for _, p in ipairs(Server_WS_Ports) do
    table.insert(WS_URLS, "ws://localhost:" .. p)
    table.insert(WS_URLS, "ws://127.0.0.1:" .. p)
end

local Players       = game:GetService("Players")
local Workspace     = game:GetService("Workspace")
local LogService    = game:GetService("LogService")
local HttpService   = game:GetService("HttpService")
local RunService    = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")
local TweenService  = game:GetService("TweenService")
local CaptureService = pcall(function() return game:GetService("CaptureService") end) and game:GetService("CaptureService") or nil
local VirtualUser = pcall(function() return game:GetService("VirtualUser") end) and game:GetService("VirtualUser") or nil

local LocalPlayer = Players.LocalPlayer
while not LocalPlayer do Players.PlayerAdded:Wait(); LocalPlayer = Players.LocalPlayer end

local function safeGlobal(name)
    local ok, v = pcall(function() return getfenv()[name] end)
    if ok then return v end
    return nil
end

local function pickFn(...)
    for _, fn in ipairs({...}) do
        if type(fn) == "function" then return fn end
    end
    return nil
end

local writefile_fn         = pickFn(safeGlobal("writefile"), writefile)
local readfile_fn          = pickFn(safeGlobal("readfile"), readfile)
local isfile_fn            = pickFn(safeGlobal("isfile"), isfile)
local getcustomasset_fn    = pickFn(safeGlobal("getcustomasset"), getcustomasset, syn and syn.getcustomasset, safeGlobal("getsynasset"))
local decompile_fn         = pickFn(safeGlobal("decompile"), decompile, syn and syn.decompile)
local hookmetamethod_fn    = pickFn(safeGlobal("hookmetamethod"), hookmetamethod)
local getrawmetatable_fn   = pickFn(safeGlobal("getrawmetatable"), getrawmetatable)
local setreadonly_fn       = pickFn(safeGlobal("setreadonly"), setreadonly)
local newcclosure_fn       = pickFn(safeGlobal("newcclosure"), newcclosure) or function(f) return f end
local getnamecallmethod_fn = pickFn(safeGlobal("getnamecallmethod"), getnamecallmethod)
local identifyexecutor_fn  = pickFn(safeGlobal("identifyexecutor"), identifyexecutor, safeGlobal("getexecutorname"))
local gethui_fn            = pickFn(safeGlobal("gethui"), gethui)

local function wsConnect(url)
    if syn and syn.websocket and syn.websocket.connect then return syn.websocket.connect(url) end
    if WebSocket and WebSocket.connect then return WebSocket.connect(url) end
    if Krnl and Krnl.WebSocket and Krnl.WebSocket.connect then return Krnl.WebSocket.connect(url) end
    error("No WebSocket API found in this executor")
end

local function detectExecutor()
    if identifyexecutor_fn then
        local ok, n = pcall(identifyexecutor_fn)
        if ok and type(n) == "string" and n ~= "" then return n end
    end
    if syn then return "Synapse X" end
    if Krnl then return "Krnl" end
    if Solara then return "Solara" end
    if Wave then return "Wave" end
    if Fluxus then return "Fluxus" end
    if Potassium then return "Potassium" end
    if Delta or delta then return "Delta" end
    if Trigon then return "Trigon" end
    if Velocity then return "Velocity" end
    return "Unknown"
end

local function detectDevice()
    local touch = UserInputService.TouchEnabled
    local mouse = UserInputService.MouseEnabled
    local gamepad = UserInputService.GamepadEnabled
    local vr = UserInputService.VREnabled
    if vr then return "VR" end
    if gamepad and not touch then return "Console" end
    if touch and not mouse then return "Mobile" end
    if touch and mouse then return "Tablet" end
    return "Desktop"
end

local CAPS = {
    writefile = writefile_fn ~= nil,
    readfile = readfile_fn ~= nil,
    isfile = isfile_fn ~= nil,
    getcustomasset = getcustomasset_fn ~= nil,
    decompile = decompile_fn ~= nil,
    hookmetamethod = hookmetamethod_fn ~= nil,
    getrawmetatable = getrawmetatable_fn ~= nil,
    newcclosure = type(newcclosure) == "function",
    getnamecallmethod = getnamecallmethod_fn ~= nil,
    capture_service = CaptureService ~= nil,
    gethui = gethui_fn ~= nil,
    virtual_user = VirtualUser ~= nil,
    anti_afk = VirtualUser ~= nil,
}

local EXECUTOR = detectExecutor()
local DEVICE = detectDevice()

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
        info.position = vec3(inst.Position); info.size = vec3(inst.Size); info.anchored = inst.Anchored
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
    if t == "Instance" then return { __type = "Instance", path = v:GetFullName(), class = v.ClassName }
    elseif t == "Vector3" then return { __type = "Vector3", x = v.X, y = v.Y, z = v.Z }
    elseif t == "Vector2" then return { __type = "Vector2", x = v.X, y = v.Y }
    elseif t == "CFrame" then return { __type = "CFrame", pos = { v.X, v.Y, v.Z } }
    elseif t == "Color3" then return { __type = "Color3", r = v.R, g = v.G, b = v.B }
    elseif t == "EnumItem" then return { __type = "EnumItem", name = tostring(v) }
    elseif t == "BrickColor" then return { __type = "BrickColor", name = v.Name }
    elseif t == "table" then
        local o, n = {}, 0
        for k, val in pairs(v) do
            n = n + 1
            if n > 50 then o.__truncated = true; break end
            o[tostring(k)] = flattenArg(val, depth + 1)
        end
        return o
    elseif t == "string" or t == "number" or t == "boolean" or t == "nil" then return v
    else return { __type = t, str = tostring(v) }
    end
end

local function flattenArgList(args)
    local out = {}
    local n = select("#", table.unpack(args))
    for i = 1, n do out[i] = flattenArg(args[i]) end
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

local Status = {}
do
    local sg, frame, dot, glow, label, sub, pulseTween, slidIn
    local PALETTE = {
        idle         = Color3.fromRGB(120, 130, 145),
        connected    = Color3.fromRGB(98, 232, 135),
        reconnecting = Color3.fromRGB(255, 215, 70),
        error        = Color3.fromRGB(255, 90, 110),
    }

    local function pickParent()
        if gethui_fn then
            local ok, p = pcall(gethui_fn)
            if ok and p then return p end
        end
        local ok, cg = pcall(function() return game:GetService("CoreGui") end)
        if ok and cg then
            local can = pcall(function() local t = Instance.new("Folder"); t.Parent = cg; t:Destroy() end)
            if can then return cg end
        end
        local pg = LocalPlayer:FindFirstChildOfClass("PlayerGui") or LocalPlayer:WaitForChild("PlayerGui", 5)
        return pg
    end

    function Status.build()
        if sg then return end
        sg = Instance.new("ScreenGui")
        sg.Name = "MCPStatusUI"
        sg.ResetOnSpawn = false
        sg.IgnoreGuiInset = true
        sg.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
        sg.DisplayOrder = 999
        local parent = pickParent()
        if not parent then return end
        sg.Parent = parent

        frame = Instance.new("Frame")
        frame.Name = "Pill"
        frame.AnchorPoint = Vector2.new(1, 1)
        frame.Position = UDim2.new(1, 280, 1, -16)
        frame.Size = UDim2.new(0, 240, 0, 48)
        frame.BackgroundColor3 = Color3.fromRGB(13, 15, 19)
        frame.BackgroundTransparency = 0.08
        frame.BorderSizePixel = 0
        frame.Parent = sg

        local corner = Instance.new("UICorner", frame); corner.CornerRadius = UDim.new(0, 12)
        local stroke = Instance.new("UIStroke", frame); stroke.Color = Color3.fromRGB(40, 48, 60); stroke.Thickness = 1; stroke.Transparency = 0.3

        dot = Instance.new("Frame", frame)
        dot.Name = "Dot"
        dot.Size = UDim2.new(0, 12, 0, 12)
        dot.AnchorPoint = Vector2.new(0, 0.5)
        dot.Position = UDim2.new(0, 16, 0.5, 0)
        dot.BackgroundColor3 = PALETTE.idle
        dot.BorderSizePixel = 0
        local dotC = Instance.new("UICorner", dot); dotC.CornerRadius = UDim.new(1, 0)

        glow = Instance.new("UIStroke", dot)
        glow.Color = PALETTE.idle; glow.Thickness = 0; glow.Transparency = 0.5

        label = Instance.new("TextLabel", frame)
        label.BackgroundTransparency = 1
        label.Position = UDim2.new(0, 38, 0, 6)
        label.Size = UDim2.new(1, -48, 0, 16)
        label.Font = Enum.Font.GothamMedium
        label.TextSize = 13
        label.TextColor3 = Color3.fromRGB(218, 226, 240)
        label.TextXAlignment = Enum.TextXAlignment.Left
        label.Text = "RobloxMCP"

        sub = Instance.new("TextLabel", frame)
        sub.BackgroundTransparency = 1
        sub.Position = UDim2.new(0, 38, 0, 24)
        sub.Size = UDim2.new(1, -48, 0, 14)
        sub.Font = Enum.Font.Gotham
        sub.TextSize = 11
        sub.TextColor3 = Color3.fromRGB(130, 142, 160)
        sub.TextXAlignment = Enum.TextXAlignment.Left
        sub.Text = "Disconnected"

        TweenService:Create(frame, TweenInfo.new(0.6, Enum.EasingStyle.Quint, Enum.EasingDirection.Out), {
            Position = UDim2.new(1, -16, 1, -16),
        }):Play()
        slidIn = true
    end

    local function startPulse()
        if pulseTween then return end
        pulseTween = TweenService:Create(glow, TweenInfo.new(0.9, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true), {
            Thickness = 6, Transparency = 0.85,
        })
        pulseTween:Play()
    end
    local function stopPulse()
        if pulseTween then pulseTween:Cancel(); pulseTween = nil end
        TweenService:Create(glow, TweenInfo.new(0.25), { Thickness = 0 }):Play()
    end

    function Status.set(state, detail)
        if not frame then return end
        local color = PALETTE[state] or PALETTE.idle
        TweenService:Create(dot, TweenInfo.new(0.25), { BackgroundColor3 = color }):Play()
        TweenService:Create(glow, TweenInfo.new(0.25), { Color = color }):Play()
        if state == "connected" then label.Text = "RobloxMCP · Connected"
        elseif state == "reconnecting" then label.Text = "RobloxMCP · Reconnecting"
        elseif state == "error" then label.Text = "RobloxMCP · Error"
        else label.Text = "RobloxMCP" end
        if detail then sub.Text = detail else sub.Text = state end
        if state == "reconnecting" then startPulse() else stopPulse() end
    end

    function Status.dismiss()
        if not frame then return end
        TweenService:Create(frame, TweenInfo.new(0.4, Enum.EasingStyle.Quint, Enum.EasingDirection.In), {
            Position = UDim2.new(1, 280, 1, -16),
        }):Play()
    end
end

pcall(Status.build)
Status.set("idle", "Starting…")

local antiAfk = {
    enabled = Anti_AFK and VirtualUser ~= nil,
    triggers = 0,
    last_triggered_at = 0,
    available = VirtualUser ~= nil,
    connection = nil,
}

local function startAntiAfk()
    if antiAfk.connection then return end
    if not VirtualUser then return end
    if not LocalPlayer then return end
    antiAfk.connection = LocalPlayer.Idled:Connect(function()
        if not antiAfk.enabled then return end
        local ok = pcall(function()
            VirtualUser:CaptureController()
            VirtualUser:ClickButton2(Vector2.new())
        end)
        if ok then
            antiAfk.triggers = antiAfk.triggers + 1
            antiAfk.last_triggered_at = os.time()
            send({ event = "log", level = "info", message = ("[anti-afk] fired (#%d)"):format(antiAfk.triggers) })
        end
    end)
end

local function stopAntiAfk()
    if antiAfk.connection then antiAfk.connection:Disconnect(); antiAfk.connection = nil end
end

if antiAfk.enabled then pcall(startAntiAfk) end

local actions = {}

actions.get_anti_afk_status = function()
    return true, {
        enabled = antiAfk.enabled,
        available = antiAfk.available,
        triggers = antiAfk.triggers,
        last_triggered_at = antiAfk.last_triggered_at,
        seconds_since_last_trigger = antiAfk.last_triggered_at > 0 and (os.time() - antiAfk.last_triggered_at) or nil,
    }
end

actions.set_anti_afk = function(msg)
    if not VirtualUser then return false, "VirtualUser not available on this client" end
    local want = msg.enabled
    if type(want) ~= "boolean" then return false, "enabled (bool) required" end
    antiAfk.enabled = want
    if want then
        pcall(startAntiAfk)
    else
        pcall(stopAntiAfk)
    end
    return true, { enabled = antiAfk.enabled }
end

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
    local p = findPlayer(msg.name); if not p then return false, "player not found" end
    local char = p.Character
    local hrp = char and char:FindFirstChild("HumanoidRootPart")
    local hum = char and char:FindFirstChildOfClass("Humanoid")
    return true, {
        name = p.Name, display_name = p.DisplayName, user_id = p.UserId, account_age = p.AccountAge,
        team = p.Team and p.Team.Name or nil,
        health = hum and hum.Health or nil, max_health = hum and hum.MaxHealth or nil,
        walk_speed = hum and hum.WalkSpeed or nil,
        position = hrp and vec3(hrp.Position) or nil,
        in_character = char ~= nil, tool_equipped = equippedTool(char),
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
        local nameOk = (not nameMatch) or string.find(string.lower(inst.Name), nameMatch, 1, true) ~= nil
        local classOk = (not className) or inst.ClassName == className
        if nameOk and classOk then
            table.insert(out, partInfo(inst))
            if #out >= max then break end
        end
    end
    return true, out
end

actions.query_instances = function(msg)
    local root = msg.root_path and resolvePathFull(msg.root_path) or game
    if not root then return false, "root_path not found" end
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
    if not decompile_fn then return false, "executor does not expose `decompile` (typical on Mobile / low-UNC executors)" end
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
        if not match and include_bindables then match = cls == "BindableEvent" or cls == "BindableFunction" end
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
        else return false, "invoke requires RemoteFunction or BindableFunction, got " .. cls end
    else
        if cls == "RemoteEvent" or cls == "UnreliableRemoteEvent" then
            local ok, err = pcall(function() inst:FireServer(table.unpack(args)) end)
            if not ok then return false, tostring(err) end
        elseif cls == "BindableEvent" then
            local ok, err = pcall(function() inst:Fire(table.unpack(args)) end)
            if not ok then return false, tostring(err) end
        else return false, "not a fireable type: " .. cls end
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
    if not (hookmetamethod_fn and getrawmetatable_fn and getnamecallmethod_fn) then
        return false, "executor lacks hookmetamethod / getrawmetatable / getnamecallmethod (typical on Mobile / low-UNC)"
    end
    local ok, err = pcall(function()
        spyOriginalNamecall = hookmetamethod_fn(game, "__namecall", newcclosure_fn(function(self, ...)
            if spyEnabled then
                local okType = pcall(function() return typeof(self) end)
                if okType and typeof(self) == "Instance" then
                    local method = getnamecallmethod_fn()
                    local cls = self.ClassName
                    if (method == "FireServer" or method == "InvokeServer" or method == "Fire" or method == "Invoke")
                        and (cls == "RemoteEvent" or cls == "RemoteFunction" or cls == "BindableEvent" or cls == "BindableFunction" or cls == "UnreliableRemoteEvent")
                    then
                        local args = { ... }
                        local entry = { ts = os.time(), path = self:GetFullName(), method = method, class = cls, args = flattenArgList(args) }
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
    return true, { enabled = true, max_buffer = spyMax }
end
actions.stop_remote_spy = function() spyEnabled = false; return true, { stopped = true } end
actions.get_remote_log = function(msg)
    local limit = msg.limit or 100
    local filter = msg.path_match and string.lower(msg.path_match) or nil
    local out = {}
    local startIdx = math.max(1, #spyBuffer - limit + 1)
    for i = startIdx, #spyBuffer do
        local e = spyBuffer[i]
        if filter then if string.find(string.lower(e.path), filter, 1, true) then table.insert(out, e) end
        else table.insert(out, e) end
    end
    return true, out
end
actions.clear_remote_log = function() spyBuffer = {}; return true, { cleared = true } end

actions.snapshot_state = function(msg)
    local root = (msg.root_path and msg.root_path ~= "") and resolvePathFull(msg.root_path) or Workspace
    if not root then return false, "root not found" end
    local max = msg.max or 2000
    local out = {}
    for _, inst in ipairs(root:GetDescendants()) do
        if #out >= max then break end
        local entry = { path = instancePath(inst), class = inst.ClassName, name = inst.Name }
        if inst:IsA("BasePart") then entry.position = vec3(inst.Position) end
        table.insert(out, entry)
    end
    return true, out
end

actions.describe_view = function(msg)
    local cam = Workspace.CurrentCamera
    if not cam then return false, "no camera" end
    local viewport = cam.ViewportSize
    local camPos = cam.CFrame.Position
    local maxDist = msg.max_distance or 200
    local maxParts = msg.max_parts or 50
    local includeUi = msg.include_ui ~= false

    local result = {
        camera = { position = vec3(camPos), look_vector = vec3(cam.CFrame.LookVector), up_vector = vec3(cam.CFrame.UpVector), fov = cam.FieldOfView, viewport = { x = viewport.X, y = viewport.Y } },
        players = {}, nearby_parts = {}, ui_visible = {},
    }

    for _, p in ipairs(Players:GetPlayers()) do
        local char = p.Character
        local hrp = char and char:FindFirstChild("HumanoidRootPart")
        local hum = char and char:FindFirstChildOfClass("Humanoid")
        if hrp then
            local sp, onScreen = cam:WorldToViewportPoint(hrp.Position)
            local dist = (hrp.Position - camPos).Magnitude
            local rayParams = RaycastParams.new()
            rayParams.FilterDescendantsInstances = { char, LocalPlayer and LocalPlayer.Character or nil }
            rayParams.FilterType = Enum.RaycastFilterType.Exclude
            local ray = Workspace:Raycast(camPos, hrp.Position - camPos, rayParams)
            table.insert(result.players, {
                name = p.Name, distance = dist,
                screen = { x = sp.X, y = sp.Y, depth = sp.Z },
                on_screen = onScreen, occluded = ray ~= nil, is_local = p == LocalPlayer,
                team = p.Team and p.Team.Name or nil,
                team_color = p.TeamColor and p.TeamColor.Name or nil,
                health = hum and hum.Health or nil, max_health = hum and hum.MaxHealth or nil,
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
                    name = part.Name, class = part.ClassName, path = instancePath(part),
                    distance = (part.Position - camPos).Magnitude, on_screen = onScreen,
                    screen = { x = sp.X, y = sp.Y, depth = sp.Z },
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
                        local pos = inst.AbsolutePosition; local sz = inst.AbsoluteSize
                        table.insert(result.ui_visible, {
                            text = string.sub(txt, 1, 200), class = inst.ClassName, path = instancePath(inst),
                            pos = { x = pos.X, y = pos.Y }, size = { x = sz.X, y = sz.Y },
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
    CaptureService:CaptureScreenshot(function(id) contentId = id; done = true end)
    local t0 = tick()
    while not done and tick() - t0 < 8 do task.wait(0.05) end
    if not done then return false, "capture timed out" end
    local result = { content_id = contentId }
    if CaptureService.SaveScreenshotAsync and writefile_fn then
        local rel = "mcp_screenshot.png"
        local ok = pcall(function() CaptureService:SaveScreenshotAsync(contentId, { Path = rel }) end)
        if ok and readfile_fn and isfile_fn and isfile_fn(rel) then
            local ok2, raw = pcall(readfile_fn, rel)
            if ok2 and raw then result.image_base64 = b64encode(raw); result.mime_type = "image/png" end
        end
    end
    if not result.image_base64 then result.note = "Image bytes unavailable on this executor. Pair with describe_view for vision." end
    return true, result
end

local LEVEL_MAP = {
    [Enum.MessageType.MessageOutput]  = "info",
    [Enum.MessageType.MessageInfo]    = "info",
    [Enum.MessageType.MessageWarning] = "warn",
    [Enum.MessageType.MessageError]   = "error",
}

local logConn = nil
local authConfirmed = false

local function attachLogStream()
    if logConn then logConn:Disconnect() end
    logConn = LogService.MessageOut:Connect(function(message, msgType)
        send({ event = "log", level = LEVEL_MAP[msgType] or "info", message = message })
    end)
end

local heartbeatToken = 0

local function startHeartbeat(ws)
    heartbeatToken = heartbeatToken + 1
    local myToken = heartbeatToken
    task.spawn(function()
        while currentWs == ws and heartbeatToken == myToken do
            task.wait(10)
            if currentWs == ws and heartbeatToken == myToken then
                send({ event = "ping", ts = os.time() })
            end
        end
    end)
end

local function installHandlers(ws)
    ws.OnMessage:Connect(function(raw)
        local ok, msg = pcall(HttpService.JSONDecode, HttpService, raw)
        if not ok or type(msg) ~= "table" then return end
        if msg.event == "auth_ok" then
            authConfirmed = true
            Status.set("connected", (msg.mode == "production" and "Auth OK · " or "Local · ") .. tostring(msg.client_id or "?"):sub(1, 12))
            attachLogStream()
            startHeartbeat(ws)
            return
        end
        if msg.event == "auth_failed" then
            authConfirmed = false
            Status.set("error", "Auth FAILED: " .. tostring(msg.error or "?"))
            return
        end
        local fn = actions[msg.action]
        if not fn then reply(msg.id, false, "unknown action: " .. tostring(msg.action)); return end
        local success, result, payload = pcall(fn, msg)
        if not success then reply(msg.id, false, "runtime: " .. tostring(result))
        else reply(msg.id, result, payload) end
    end)
end

local function connectAny()
    local lastErr = "no candidate urls"
    for _, url in ipairs(WS_URLS) do
        local ok, ws = pcall(wsConnect, url)
        if ok and ws then return ws, url end
        lastErr = tostring(ws)
    end
    return nil, lastErr
end

local function sendAuth()
    local payload = {
        action = "auth",
        api_key = Client_API or "",
        roblox_user_id = LocalPlayer and LocalPlayer.UserId or nil,
        roblox_user_name = LocalPlayer and LocalPlayer.Name or nil,
        place_id = game.PlaceId,
        device_type = DEVICE,
        executor = EXECUTOR,
        capabilities = CAPS,
    }
    pcall(function() currentWs:Send(HttpService:JSONEncode(payload)) end)
end

task.spawn(function()
    local backoff = 1
    while true do
        Status.set("reconnecting", "Connecting to server…")
        local ws, urlOrErr = connectAny()
        if not ws then
            Status.set("error", "Server offline · retry " .. backoff .. "s")
            warn(("[mcp-bridge] all ports failed: %s — retry in %ds"):format(urlOrErr or "?", backoff))
            if not Keep_Reconnecting then
                Status.set("error", "Stopped (Keep_Reconnecting=false)")
                return
            end
        else
            currentWs = ws
            authConfirmed = false
            print("[mcp-bridge] connected to " .. urlOrErr)
            Status.set("reconnecting", "Authenticating…")
            installHandlers(ws)
            task.wait(0.1)
            sendAuth()
            local closed = false
            ws.OnClose:Connect(function() closed = true end)
            local handshakeDeadline = tick() + 6
            while not closed do
                task.wait(0.5)
                if not authConfirmed and tick() > handshakeDeadline then
                    Status.set("error", "No auth_ok in 6s · closing")
                    pcall(function() ws:Close() end)
                    closed = true
                end
            end
            currentWs = nil
            if logConn then logConn:Disconnect(); logConn = nil end
            if authConfirmed then
                Status.set("reconnecting", "Lost connection · retrying")
                warn("[mcp-bridge] disconnected after auth")
                backoff = 2
            else
                Status.set("error", "Auth not confirmed · backing off")
                warn("[mcp-bridge] disconnected before auth confirmed · backoff " .. backoff)
            end
            if not Keep_Reconnecting then
                Status.set("error", "Stopped (Keep_Reconnecting=false)")
                return
            end
        end
        task.wait(backoff)
        backoff = math.min(backoff * 2, 30)
    end
end)

print(("[mcp-bridge] client loaded · %s · %s"):format(DEVICE, EXECUTOR))
