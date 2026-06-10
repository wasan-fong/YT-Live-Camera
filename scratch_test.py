import urllib.request
import urllib.parse
import re
import json

def test_search():
    query = "live camera Shibuya"
    url = f"https://www.youtube.com/results?search_query={urllib.parse.quote(query)}&sp=EgJAAQ%253D%253D"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
    }
    
    print(f"Fetching: {url}")
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req) as response:
            html = response.read().decode('utf-8')
            
        json_pattern = re.compile(r'var ytInitialData\s*=\s*({.*?});')
        match = json_pattern.search(html)
        if not match:
            json_pattern = re.compile(r'window\["ytInitialData"\]\s*=\s*({.*?});')
            match = json_pattern.search(html)
            
        if match:
            data = json.loads(match.group(1))
            try:
                contents = data['contents']['twoColumnSearchResultsRenderer']['primaryContents']['sectionListRenderer']['contents']
            except KeyError as e:
                print("KeyError in parsing JSON keys:", e)
                return
                
            results = []
            for section in contents:
                item_section = section.get('itemSectionRenderer', {})
                contents_items = item_section.get('contents', [])
                for item in contents_items:
                    video_renderer = item.get('videoRenderer', {})
                    if not video_renderer:
                        continue
                        
                    video_id = video_renderer.get('videoId')
                    if not video_id:
                        continue
                        
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
                        "channel": channel
                    })
            print(f"Success! Found {len(results)} items:")
            for idx, res in enumerate(results[:5]):
                print(f"{idx+1}: [{res['id']}] {res['channel']} - {res['title']}")
        else:
            print("Could not find ytInitialData in HTML source.")
    except Exception as e:
        print("Error encountered:", e)

if __name__ == "__main__":
    test_search()
