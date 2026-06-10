from fastapi import FastAPI, Request, HTTPException, WebSocket, WebSocketDisconnect, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from typing import List
import uvicorn
import json
import urllib.request
import urllib.parse
import re

app = FastAPI(title="YT Live Camera Dashboard")

# WebSocket Connection Manager
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def broadcast(self, message: str):
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except Exception:
                # Handle stale connections
                pass

manager = ConnectionManager()

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # Wait for any message from clients (e.g. Console)
            data = await websocket.receive_text()
            # Broadcast it to everyone (including Dashboards on other PCs)
            await manager.broadcast(data)
    except WebSocketDisconnect:
        manager.disconnect(websocket)

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# Setup templates
templates = Jinja2Templates(directory="templates")

import json

class PlaylistUpdate(BaseModel):
    playlist: List[dict]

@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse(request, "index.html")

@app.get("/console", response_class=HTMLResponse)
async def read_console(request: Request):
    return templates.TemplateResponse(request, "console.html")

@app.get("/.well-known/appspecific/com.chrome.devtools.json")
async def chrome_devtools_json():
    return {}

@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return Response(status_code=204)

@app.get("/playlist")
async def get_playlist():
    try:
        with open("playlist.pl", "r") as f:
            content = f.read().strip()
            if not content:
                return {"playlist": []}
            
            try:
                # Try to parse as JSON
                ids = json.loads(content)
                # Ensure it's a list of dicts
                if isinstance(ids, list) and len(ids) > 0 and isinstance(ids[0], str):
                    # Migrating from list of strings to list of dicts
                    ids = [{"id": x, "name": "", "group": ""} for x in ids]
                return {"playlist": ids}
            except json.JSONDecodeError:
                # Old line-by-line format migration
                lines = content.splitlines()
                ids = [{"id": line.strip(), "name": "", "group": ""} for line in lines if line.strip()]
                return {"playlist": ids}
    except FileNotFoundError:
        return {"playlist": []}

@app.get("/playlist/original")
async def get_original_playlist():
    try:
        with open("playlist_original.pl", "r") as f:
            content = f.read().strip()
            if not content:
                return {"playlist": []}
            return {"playlist": json.loads(content)}
    except FileNotFoundError:
        return {"playlist": []}

@app.post("/playlist")
async def update_playlist(data: PlaylistUpdate):
    try:
        with open("playlist.pl", "w") as f:
            json.dump(data.playlist, f, indent=4)
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class BannedUpdate(BaseModel):
    banned: List[dict]

@app.get("/banned")
async def get_banned():
    try:
        with open("banned.pl", "r") as f:
            content = f.read().strip()
            if not content:
                return {"banned": []}
            return {"banned": json.loads(content)}
    except FileNotFoundError:
        return {"banned": []}

@app.post("/banned")
async def update_banned(data: BannedUpdate):
    try:
        with open("banned.pl", "w") as f:
            json.dump(data.banned, f, indent=4)
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class HistoryUpdate(BaseModel):
    history: List[dict]

@app.get("/history")
async def get_history():
    try:
        with open("history.pl", "r") as f:
            content = f.read().strip()
            if not content:
                return {"history": []}
            return {"history": json.loads(content)}
    except FileNotFoundError:
        return {"history": []}

@app.post("/history")
async def update_history(data: HistoryUpdate):
    try:
        with open("history.pl", "w") as f:
            json.dump(data.history, f, indent=4)
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def parse_search_items(contents, results, playlist_ids, banned_ids, history_ids, live):
    continuation_token = None
    for section in contents:
        # Check for itemSectionRenderer
        item_section = section.get('itemSectionRenderer', {})
        if item_section:
            contents_items = item_section.get('contents', [])
            for item in contents_items:
                video_renderer = item.get('videoRenderer', {})
                if video_renderer:
                    video_id = video_renderer.get('videoId')
                    if video_id and video_id not in playlist_ids and video_id not in banned_ids and video_id not in history_ids:
                        title = ""
                        title_runs = video_renderer.get('title', {}).get('runs', [])
                        if title_runs:
                            title = title_runs[0].get('text', '')
                        channel = ""
                        owner_runs = video_renderer.get('ownerText', {}).get('runs', [])
                        if owner_runs:
                            channel = owner_runs[0].get('text', '')
                        results.append({
                            "id": video_id,
                            "title": title,
                            "thumbnail": f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg",
                            "channel": channel,
                            "isLive": live
                        })
        # Check for continuationItemRenderer directly in section list
        continuation_renderer = section.get('continuationItemRenderer', {})
        if continuation_renderer:
            continuation_token = continuation_renderer.get('continuationEndpoint', {}).get('continuationCommand', {}).get('token')
            
    # Sometimes continuation is inside itemSectionRenderer's contents list
    for section in contents:
        item_section = section.get('itemSectionRenderer', {})
        if item_section:
            contents_items = item_section.get('contents', [])
            for item in contents_items:
                continuation_renderer = item.get('continuationItemRenderer', {})
                if continuation_renderer:
                    continuation_token = continuation_renderer.get('continuationEndpoint', {}).get('continuationCommand', {}).get('token')
                    
    return continuation_token

@app.get("/api/search")
async def search_yt(q: str, live: bool = True):
    if not q:
        return {"results": []}
    
    # 1. Fetch current playlist, banned list, and history list to filter out
    playlist_ids = set()
    try:
        with open("playlist.pl", "r") as f:
            content = f.read().strip()
            if content:
                p_data = json.loads(content)
                playlist_ids = {item.get("id") for item in p_data if isinstance(item, dict) and item.get("id")}
    except Exception:
        pass

    banned_ids = set()
    try:
        with open("banned.pl", "r") as f:
            content = f.read().strip()
            if content:
                banned_data = json.loads(content)
                banned_ids = {item.get("id") for item in banned_data if isinstance(item, dict) and item.get("id")}
    except Exception:
        pass

    history_ids = set()
    try:
        with open("history.pl", "r") as f:
            content = f.read().strip()
            if content:
                history_data = json.loads(content)
                history_ids = {item.get("id") for item in history_data if isinstance(item, dict) and item.get("id")}
    except Exception:
        pass

    # sp=EgJAAQ%3D%3D is filters for live streams only on YouTube
    sp = "EgJAAQ%3D%3D" if live else ""
    url = f"https://www.youtube.com/results?search_query={urllib.parse.quote(q)}"
    if sp:
        url += f"&sp={sp}"
        
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
    }
    
    results = []
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=5) as response:
            html = response.read().decode('utf-8')
            
        api_key_match = re.search(r'"innertubeApiKey"\s*:\s*"([^"]+)"', html)
        api_key = api_key_match.group(1) if api_key_match else None
        
        json_pattern = re.compile(r'var ytInitialData\s*=\s*({.*?});')
        match = json_pattern.search(html)
        if not match:
            json_pattern = re.compile(r'window\["ytInitialData"\]\s*=\s*({.*?});')
            match = json_pattern.search(html)
            
        if not match:
            return {"results": []}
            
        data = json.loads(match.group(1))
        contents = data['contents']['twoColumnSearchResultsRenderer']['primaryContents']['sectionListRenderer']['contents']
        
        continuation_token = parse_search_items(contents, results, playlist_ids, banned_ids, history_ids, live)
        
        # Subsequent pages logic using InnerTube continuation
        page = 2
        max_pages = 8 # Prevent infinite looping, usually ~5 pages are enough to get 100 filtered items
        while continuation_token and len(results) < 100 and api_key and page <= max_pages:
            api_url = f"https://www.youtube.com/youtubei/v1/search?key={api_key}"
            post_data = {
                "context": {
                    "client": {
                        "clientName": "WEB",
                        "clientVersion": "2.20230622.01.00",
                        "hl": "en",
                        "gl": "US"
                    }
                },
                "continuation": continuation_token
            }
            
            post_bytes = json.dumps(post_data).encode('utf-8')
            req_post = urllib.request.Request(
                api_url, 
                data=post_bytes,
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": headers["User-Agent"]
                }
            )
            
            with urllib.request.urlopen(req_post, timeout=5) as response:
                res_json = json.loads(response.read().decode('utf-8'))
                
            commands = res_json.get('onResponseReceivedCommands', [])
            next_token = None
            for cmd in commands:
                append_cmd = cmd.get('appendContinuationItemsAction', {})
                if append_cmd:
                    items = append_cmd.get('continuationItems', [])
                    for item in items:
                        video_renderer = item.get('videoRenderer', {})
                        if video_renderer:
                            video_id = video_renderer.get('videoId')
                            if video_id and video_id not in playlist_ids and video_id not in banned_ids and video_id not in history_ids:
                                title = ""
                                title_runs = video_renderer.get('title', {}).get('runs', [])
                                if title_runs:
                                    title = title_runs[0].get('text', '')
                                channel = ""
                                owner_runs = video_renderer.get('ownerText', {}).get('runs', [])
                                if owner_runs:
                                    channel = owner_runs[0].get('text', '')
                                results.append({
                                    "id": video_id,
                                    "title": title,
                                    "thumbnail": f"https://img.youtube.com/vi/{video_id}/mqdefault.jpg",
                                    "channel": channel,
                                    "isLive": live
                                })
                        continuation_renderer = item.get('continuationItemRenderer', {})
                        if continuation_renderer:
                            next_token = continuation_renderer.get('continuationEndpoint', {}).get('continuationCommand', {}).get('token')
            
            continuation_token = next_token
            page += 1
            
        return {"results": results[:100]}
    except Exception as e:
        print("Search API error:", e)
        return {"results": results[:100]}

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8100, reload=True)
