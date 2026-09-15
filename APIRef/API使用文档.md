相关管理要求见腾讯内部AI编码辅助工具安全使用规范
 
chat/completions
 （正式服）URL：http://api.timiai.woa.com/ai_api_manage/llmproxy/chat/completions 
 
1. 接口说明
接口类型和格式： Post接口 + json格式 body请求
Headers：Authorization(必填)， 使用用户个人在平台申请的API Key 
【注：测试服、正式服API key不共用】
 
 
Body参数：
参数	说明	备注
model（必填）	模型名称	 平台模型库查看模型名称
 
messages（必填）	对话上下文	 
stream	是否开启流式输出，默认为true	非流式时返回json，流式回包格式对齐openapi输出
2. Curl 调用示例
测试服：

1curl -X POST 'http://api.timiai.woa.com/ai_api_manage/llmproxy/chat/completions' -H 'Content-Type: application/json' -H 'Authorization: 7HQXF******sPmYxMp' -d '{
2    "model": "gpt-5",                                          
3    "messages": [
4        {
5            "role": "user",
6            "content": "Hello"
7        }                     
8    ]    
9}'
3. Python调用示例
requests格式请求：

1import json
2import requests
3
4url = "http://api.timiai.woa.com/ai_api_manage/llmproxy/chat/completions"   #  正式服替换域名  api.timiai.woa.com
5data_dict = {
6    'model': 'gpt-5',  # 模型对应平台库可查询到的模型名称
7    'messages': [
8        {
9            "role": "user",
10            "content": "Hello word"
11        }
12    ]
13}
14
15headers = {
16    'Content-Type': 'application/json',
17    'Authorization': '7HQXF******sPmYxMp'  # 对应平台个人API Key, 且确保API key有对应模型调用权限
18}
19
20response = requests.post(url, headers=headers, data=json.dumps(data_dict))
21
22# 判断是否异常
23if response.status_code != 200:
24    # 异常处理
25    print(response.json())
26    exit()
27
28print(response.json())
OpenAI格式请求：

1from openai import OpenAI
2
3client = OpenAI(
4    base_url="http://api.timiai.woa.com/ai_api_manage/llmproxy",   # 正式服替换域名  api.timiai.woa.com
5    api_key='7HQXF******sPmYxMp'  # 对应平台个人API Key, 且确保API key有对应模型调用权限
6)
7
8# 使用 OpenAI Python 库发送请求
9response = client.chat.completions.create(
10    model="gpt-5",
11    messages=[
12        {
13            "role": "user",
14            "content": "Hello word"
15        }
16    ]
17)
18print(response)
19print("AI 回复:", response.choices[0].message.content)
20
 
 
 
 	如没有API Key，请先申请加入对应应用组，然后创建个人API key
如API Key没有模型 API的权限（平台模型库已上架模型），请联系应用组管理员申请对应API模型资源
如需使用平台模型库未上架模型，请联系 jensli （李行健） 申请和上架对应资源

 
responses
 （正式服）URL：http://api.timiai.woa.com/ai_api_manage/llmproxy/responses
1. 接口说明
接口描述：对齐 OpenAI 的 responses 接口所对应的请求和响应，支持平台所有已部署模型
接口类型和格式： Post接口 + json格式 body请求
Headers：Authorization(必填)， 使用用户个人在平台申请的API Key
 
Body参数：
参数	参数类型	是否必填	说明	备注
model	string	是	模型名称	 平台模型库查看模型名称
 
 
input	array	是	对话上下文	 
stream	bool	否	是否开启流式输出，默认为true	非流式时返回json，流式回包格式对齐openapi输出
 
2. Curl 调用示例
测试服：

1curl -X POST 'http://api.timiai.woa.com/ai_api_manage/llmproxy/responses' -H 'Content-Type: application/json' -H 'Authorization: 7HQXF******sPmYxMp' -d '{
2    "model": "gpt-5",                                          
3    "input": [
4        {
5            "role": "user",
6            "content": "Hello"
7        }                     
8    ]    
9}'
3. Python 调用示例
requests格式请求：

1import json
2import requests
3
4url = "http://api.timiai.woa.com/ai_api_manage/llmproxy/responses"  # 正式服：替换域名  api.timiai.woa.com
5data_dict = {
6    'model': 'gpt-5',  # 模型对应平台库可查询到的模型名称
7    'input': [
8        {
9            "role": "user",
10            "content": "Hello word"
11        }
12    ]
13}
14
15headers = {
16    'Content-Type': 'application/json',
17    'Authorization': '7HQXF******sPmYxMp'  # 对应平台个人API Key, 且确保API key有对应模型调用权限
18}
19
20response = requests.post(url, headers=headers, data=json.dumps(data_dict))
21
22# 判断是否异常
23if response.status_code != 200:
24    # 异常处理
25    print(response.json())
26    exit()
27
28print(response.json())
OpenAI格式请求：

1from openai import OpenAI
2
3client = OpenAI(
4    base_url="http://api.timiai.woa.com/ai_api_manage/llmproxy",  # 正式服：替换域名  api.timiai.woa.com
5    api_key='7HQXF******sPmYxMp'  # 对应平台个人API Key, 且确保API key有对应模型调用权限
6)
7
8# 使用 OpenAI Python 库发送请求
9response = client.responses.create(
10    model="gpt-5",
11    messages=[
12        {
13            "role": "user",
14            "content": "Hello word"
15        }
16    ]
17)
18print(response)
19print("AI 回复:", response.choices[0].message.content)
20
 
一、文生图接口（Text-to-Image）
1. 接口说明
接口类型和格式：POST接口 + json格式 body请求
Headers：Authorization（必填），使用用户个人在平台申请的API Key
⚠️ 【注：测试服、正式服API key不共用! 】
2. 接口地址
•	正式服：http://api.timiai.woa.com/ai_api_manage/llmproxy/images/generations
3. 请求参数
Body参数
参数名	说明	备注
model（必填）	模型名称	固定为 "gemini-3-pro-image-preview"
prompt（必填）	图像生成的文本描述	平台模型库查看模型说明
n	生成图片数量	默认为 1
aspect_ratio	图片宽高比	默认为 "1:1"，支持：1:1, 4:3, 16:9, 21:9, 9:16
imageSize	图片尺寸	支持：1K, 2K, 4K
aspect_ratio（宽高比）详细说明
宽高比	说明
1:1	正方形（默认）
4:3	标准比例
16:9	宽屏
21:9	超宽屏
4:5	标准比例2
imageSize（图片尺寸）详细说明
尺寸	说明
1K	标清
2K	高清
4K	超清
4. 响应格式
成功响应
{
  "created": 1765182120,
  "background": null,
  "data": [
    {
      "b64_json": "iVBORw0KGgoAAAANSUhEUgAA...",
      "revised_prompt": null,
      "url": null
    }
  ],
  "output_format": null,
  "quality": null,
  "size": null,
  "usage": {
    "total_tokens": 0,
    "input_tokens": 0,
    "input_tokens_details": {
      "image_tokens": 0,
      "text_tokens": 0
    },
    "output_tokens": 0
  }
}
错误响应
{
  "code": "CUSTOMIZATION",
  "message": "请求数据缺少model"
}
5. Curl 调用示例
curl -X POST 'http://api.timiai.woa.com/ai_api_manage/llmproxy/images/generations' \ 
  -H 'Content-Type: application/json' \ 
  -H 'Authorization: 7HQXF******sPmYxMp' \ 
  -d '{
    "model": "gemini-3-pro-image-preview",
    "prompt": "一只可爱的海獭宝宝在清澈的水中游泳",
    "n": 1,
    "aspect_ratio": "16:9",
    "imageSize": "2K"
  }'
6. Python调用示例
import json
import base64
import requests
from pathlib import Path

url = "http://api.timiai.woa.com/ai_api_manage/llmproxy/images/generations"
data_dict = {
    'model': 'gemini-3-pro-image-preview',
    'prompt': '一只可爱的海獭宝宝在清澈的水中游泳',
    'n': 1,
    'aspect_ratio': '16:9',
    'imageSize': '2K'
}

headers = {
    'Content-Type': 'application/json',
    'Authorization': '7HQXF******sPmYxMp'
}

response = requests.post(url, headers=headers, data=json.dumps(data_dict), timeout=300)

if response.status_code != 200:
    print(response.json())
    exit()

result = response.json()

# 提取并保存图片
for idx, item in enumerate(result['data']):
    image_data = base64.b64decode(item['b64_json'])
    Path(f"generated_image_{idx + 1}.png").write_bytes(image_data)
    print(f"图片已保存: generated_image_{idx + 1}.png")
________________________________________
二、图生图接口（Image-to-Image）
1. 接口说明
用于基于参考图片和文本描述进行图片编辑、风格转换或内容修改。
⚠️ 【注：测试服、正式服API key不共用! 】
2. 接口地址
•	正式服：http://api.timiai.woa.com/ai_api_manage/llmproxy/chat/completions
3. 请求参数
参数名	说明	备注
model（必填）	模型名称	固定为 "gemini-3-pro-image-preview"
messages（必填）	对话消息数组	包含文本和图片内容
image_config	图像配置	aspect_ratio（1:1/4:3/16:9/21:9/9:16/4:5）、image_size（1K/2K/4K）
response_modalities	响应模态	通常为 ["IMAGE", "TEXT"]
图片输入方式
URL方式（推荐）：避免请求体过大
{"type": "image_url", "image_url": {"url": "https://example.com/image.jpg"}}
Base64方式：适合小图片（<1MB）
{"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo..."}}
4. 响应格式
{
  "id": "KHw6ae2rD7****ufOW8A8",
  "choices": [
    {
      "message": {
        "images": [
          {"image_url": {"url": "data:image/png;base64,..."}}
        ],
        "content": "根据您的要求，我为图中的动物添加了一顶帽子"
      }
    }
  ],
  "usage": {
    "total_tokens": 1851,
    "completion_tokens_details": {"image_tokens": 1120}
  }
}
关键字段：
•	choices[0].message.images[0].image_url.url：生成的图片（Base64编码）
•	choices[0].message.content：模型的文本回复
•	usage.completion_tokens_details.image_tokens：图片Token消耗
5. Curl 调用示例
单图示例
curl -X POST 'http://api.timiai.woa.com/ai_api_manage/llmproxy/chat/completions' \ 
  -H 'Content-Type: application/json' \ 
  -H 'Authorization: 7HQXF******sPmYxMp' \ 
  -d '{
    "model": "gemini-3-pro-image-preview",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "给图中的动物戴上一顶帽子"},
        {"type": "image_url", "image_url": {"url": "https://example.com/animal.jpg"}}
      ]
    }],
    "image_config": {"aspect_ratio": "1:1", "image_size": "4K"},
    "response_modalities": ["IMAGE", "TEXT"]
  }'
多图示例
curl -X POST 'http://api.timiai.woa.com/ai_api_manage/llmproxy/chat/completions' \ 
  -H 'Content-Type: application/json' \ 
  -H 'Authorization: 7HQXF******sPmYxMp' \ 
  -d '{
    "model": "gemini-3-pro-image-preview",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "将第一张图的风格应用到第二张图上"},
        {"type": "image_url", "image_url": {"url": "https://example.com/style.jpg"}},
        {"type": "image_url", "image_url": {"url": "https://example.com/content.jpg"}}
      ]
    }],
    "image_config": {"aspect_ratio": "16:9", "image_size": "4K"},
    "response_modalities": ["IMAGE", "TEXT"]
  }'
6. Python调用示例
单图URL方式（推荐）
import base64
import requests
from pathlib import Path

url = "http://api.timiai.woa.com/ai_api_manage/llmproxy/chat/completions"
headers = {
    'Content-Type': 'application/json',
    'Authorization': '7HQXF******sPmYxMp'
}

data = {
    'model': 'gemini-3-pro-image-preview',
    'messages': [{
        'role': 'user',
        'content': [
            {'type': 'text', 'text': '给图中的动物戴上一顶帽子'},
            {'type': 'image_url', 'image_url': {'url': 'https://example.com/animal.jpg'}}
        ]
    }],
    'image_config': {'aspect_ratio': '1:1', 'image_size': '4K'},
    'response_modalities': ['IMAGE', 'TEXT']
}

response = requests.post(url, headers=headers, json=data, timeout=300)
result = response.json()

# 保存图片
for idx, img in enumerate(result['choices'][0]['message']['images']):
    base64_data = img['image_url']['url'].split(',', 1)[1]
    image_data = base64.b64decode(base64_data)
    Path(f"output_{idx}.png").write_bytes(image_data)
多图URL方式
data = {
    'model': 'gemini-3-pro-image-preview',
    'messages': [{
        'role': 'user',
        'content': [
            {'type': 'text', 'text': '将第一张图的风格应用到第二张图上'},
            {'type': 'image_url', 'image_url': {'url': 'https://example.com/style.jpg'}},
            {'type': 'image_url', 'image_url': {'url': 'https://example.com/content.jpg'}}
        ]
    }],
    'image_config': {'aspect_ratio': '16:9', 'image_size': '4K'},
    'response_modalities': ['IMAGE', 'TEXT']
}

response = requests.post(url, headers=headers, json=data, timeout=300)
Base64方式（本地图片）
import base64

def encode_image(path):
    with open(path, 'rb') as f:
        return base64.b64encode(f.read()).decode('utf-8')

# 单图
image_b64 = encode_image("test.jpg")
data['messages'][0]['content'][1] = {
    'type': 'image_url',
    'image_url': {'url': f'data:image/png;base64,{image_b64}'}
}

# 多图
image_b64_1 = encode_image("style.jpg")
image_b64_2 = encode_image("content.jpg")
data['messages'][0]['content'] = [
    {'type': 'text', 'text': '将第一张图的风格应用到第二张图上'},
    {'type': 'image_url', 'image_url': {'url': f'data:image/png;base64,{image_b64_1}'}},
    {'type': 'image_url', 'image_url': {'url': f'data:image/png;base64,{image_b64_2}'}}
]
7. 注意事项
•	URL方式优先：避免Base64编码导致请求体过大
•	超时时间：建议设置 timeout≥300 秒
•	Token消耗：图生图消耗较多Token，注意监控 usage 字段
•	并发限制：避免频繁调用，注意API限流
________________________________________
三、多轮图像生成（Multiround Image Generation）
1. 接口说明
用于实现多轮迭代式图像编辑，通过将上一轮生成的图片作为下一轮的输入，逐步优化图像效果。
核心优势：避免Base64编码导致的上下文窗口超限问题，通过COS URL传递图片。
2. 涉及接口
2.1 文件URL转换接口
用于将Base64图片上传到COS并获取外网签名URL。
•	正式服：http://api.timiai.woa.com/ai_api_manage/file/url_conversion
2.2 图像生成接口
同"二、图生图接口"，使用 /chat/completions 端点。
3. 文件URL转换接口
请求参数
参数名	说明	必填
file_base64	Base64编码的图片数据	是
file_type	文件类型	是，如：.png, .jpg
model	模型名称	否，gemini模型自动使用外网签名
响应格式
{
  "cos_file_path": "dev/api_temp/20251226/xxx.png",
  "presigned_url": "https://storage.googleapis.com/...",
  "model": "gemini-3-pro-preview",
  "file_type": ".png",
  "storage_type": "external"
}
Python调用示例
import requests

def convert_base64_to_url(base64_image, api_key, base_url):
    """将Base64图片转换为COS URL"""
    # 移除data URL前缀
    if ',' in base64_image:
        base64_image = base64_image.split(',', 1)[1]
    
    url = f"{base_url}/ai_api_manage/file/url_conversion"
    headers = {'Authorization': api_key}
    payload = {
        "file_base64": base64_image,
        "file_type": ".png",
        "model": "gemini-3-pro-image-preview"
    }
    
    response = requests.post(url, headers=headers, json=payload, timeout=60)
    
    if response.status_code == 200:
        result = response.json()
        return result.get('presigned_url')
    return None
5. 多轮生成完整示例
import base64
import requests
from pathlib import Path

# 配置
API_KEY = "7HQXF******sPmYxMp"
BASE_URL = "http://api.timiai.woa.com"
CHAT_URL = f"{BASE_URL}/ai_api_manage/llmproxy/chat/completions"
CONVERT_URL = f"{BASE_URL}/ai_api_manage/file/url_conversion"

headers = {'Authorization': API_KEY, 'Content-Type': 'application/json'}

# 定义多轮提示词
prompts = [
    '画一只可爱的柴犬',
    '给柴犬戴上红色的帽子',
    '把背景改成樱花树下',
    '变成水彩画风格'
]

messages_history = []  # 存储完整的对话历史（user + assistant）

for round_idx, prompt in enumerate(prompts, 1):
    print(f"\n=== 第 {round_idx} 轮 ===")
    
    # 构建当前轮的user消息
    user_content = [{'type': 'text', 'text': prompt}]
    
    # 构建完整的messages（历史 + 当前user消息）
    current_messages = messages_history + [{'role': 'user', 'content': user_content}]
    
    data = {
        'model': 'gemini-3-pro-image-preview',
        'messages': current_messages,
        'image_config': {'aspect_ratio': '1:1', 'image_size': '4K'},
        'response_modalities': ['IMAGE', 'TEXT']
    }
    
    # 生成图像
    response = requests.post(CHAT_URL, headers=headers, json=data, timeout=300)
    result = response.json()
    
    # 提取返回的图片和文本
    message = result['choices'][0]['message']
    base64_image = message['images'][0]['image_url']['url']
    text_response = message.get('content', '')
    
    # 保存图片
    base64_data = base64_image.split(',', 1)[1]
    image_data = base64.b64decode(base64_data)
    Path(f"round_{round_idx}.png").write_bytes(image_data)
    print(f"✅ 图片已保存: round_{round_idx}.png")
    
    # 更新对话历史：添加本轮的user消息
    messages_history.append({'role': 'user', 'content': user_content})
    
    # 转换base64为URL并构建assistant消息
    convert_payload = {
        "file_base64": base64_data,
        "file_type": ".png",
        "model": "gemini-3-pro-image-preview"
    }
    convert_resp = requests.post(CONVERT_URL, headers=headers, json=convert_payload, timeout=60)
    cos_url = convert_resp.json().get('presigned_url')
    
    # 构建assistant消息（包含文本和图片URL）
    assistant_content = []
    if text_response:
        assistant_content.append({'type': 'text', 'text': text_response})
    if cos_url:
        assistant_content.append({'type': 'image_url', 'image_url': {'url': cos_url}})
        print(f"🔗 图片已转换为URL并加入历史")
    
    # 添加assistant消息到历史
    messages_history.append({'role': 'assistant', 'content': assistant_content})
    
    print(f"📚 当前对话历史长度: {len(messages_history)} 条消息")

print("\n🎉 多轮生成完成！")
6. 关键注意事项
1.	URL转换时机：每轮生成后立即转换Base64为URL，避免累积过多Base64数据
2.	外网签名自动触发：使用 gemini-3-pro-image-preview 或 gemini-3-pro-preview 模型时，文件URL转换接口会自动使用外网签名
3.	URL有效期：COS签名URL默认有效期为1小时，请在有效期内使用
4.	请求体大小：使用URL方式避免Base64导致请求体过大
5.	超时设置：每轮生成建议设置 timeout≥300 秒
________________________________________
四、权限与资源申请
•	如没有API Key，请先申请加入对应应用组，然后创建个人API key
•	如API Key没有模型 API的权限（平台模型库已上架模型），请联系应用组管理员申请对应API模型资源
•	如需使用平台模型库未上架模型，请联系 jensli（李行健）申请和上架对应资源


基于合规侧要求，项目侧仍需按照IEG境内应用AIGC工具生成内容合规清单 及IEG AI辅助创作著作权保护合规指引进行项目内部宣导及应用自查。后续对应要求会基于平台能力做强制性提醒，涉及海外员工的需拉起沟通
一、创建视频任务
1. 接口说明
接口类型和格式：POST接口 + json格式 body请求
Headers：Authorization（必填），使用用户个人在平台申请的API Key
**【注：测试服、正式服API key不共用 】

3.文生视频
接口地址
正式服：http://api.timiai.woa.com/ai_api_manage/hunyuan/videos/text2video
Body参数
参数名	说明	备注
prompt（必填）	文本prompt	注：字符长度不能超过 2000 个字符
model	模型名称	必填，hunyuan-video-1.5-t2v-720p-tob-v1.0.0 生成720p视频
negative_prompt	原始负向Prompt	 
aspect_ratio	横纵比	默认"16:9"，支持16:9，9:16，1:1,4:3,3:4。
n	生成视频数量	默认 1，当前限制只能为1
footnote	业务自定义水印内容	限制 16 个字符长度（不区分中英文,会去换行与空格字符），生成在视频右下角。
duration	视频时长参数 float	默认值 5.0；视频时长, 单位秒；本期只允许5.0。
revise	是否开启改写	false关闭，不传或true开启改写
moderation	是否开启安审	false关闭，不传或true开启安审
示例：
{    
    "model": "hunyuan-video-aries-fast",
    "prompt":"a man walking in the space",
    "aspect_ratio": "16:9",
    "duration": 5.0
}

4.图生视频
接口地址
正式服：http://api.timiai.woa.com/ai_api_manage/hunyuan/videos/image2video
Body参数
参数名	说明	备注
prompt（必填）	文本prompt	注：字符长度不能超过 2000 个字符
model	模型名称	必填，hunyuan-video-1.5-i2v-720p-tob-v1.0.1 生成720p视频
negative_prompt	原始负向Prompt	 
image	上传图片的base64	大小不超过 10M,支持 jpg/jpeg/png 格式，长宽限制1:4 ~ 4:1 ,若与image_url同时存在，使用image作为传入图
image_url	上传图片的url	大小不超过 10M,支持 jpg/jpeg/png 格式，生成视频长宽比与传入图片保持一致
seed	生视频种子	范围[1, 4294967295]，不传时默认随机。
n	生成视频数量	默认 1，当前限制只能为1
footnote	业务自定义水印内容	限制 16 个字符长度（不区分中英文,会去换行与空格字符），生成在视频右下角。
duration	视频时长参数 float	默认值 5.0；视频时长, 单位秒；本期只允许5.0。
revise	是否开启改写	false关闭，不传或true开启改写
moderation	是否开启安审	false关闭，不传或true开启安审
示例：
{
    
    "model": "hunyuan-video-1.5-i2v-720p-tob-v1.0.1",
    "prompt":"a man walking in the space",
    "image_url":"xxxxxxxxxxxxxxxxx",
    "duration": 5.0
}

5.响应格式
成功响应
{
  "id":"3c4dfb1cebdca579675326d0dcd7fce3",
  "created":1695216150,
  "task_id": "xxx"
}
错误响应
{
  "error": {
    "message": "请求参数有误",
    "type": "invalid_request_error",
    "param": null,
    "code": 429,
    "id": "xxxx"
  }
}
6.Python调用示例
文生视频
import json
import requests
import time

# 1. 创建任务
url = "http://api.timiai.woa.com/ai_api_manage/hunyuan/videos/text2video"
headers = {
    'Content-Type': 'application/json',
    'Authorization': 'nZj0iy********dYSP',
}

data = {    
    "model": "hunyuan-video-aries-fast",
    "prompt":"a man walking in the space",
    "aspect_ratio": "16:9",
    "resolution": 720,
    "duration": 5.0
}

response = requests.post(url, headers=headers, json=data, timeout=60)
result = response.json()

if response.status_code != 200:
    print(f"任务创建失败: {result}")
    exit()

task_id = result.get('task_id')
print(f"任务创建成功，任务ID: {task_id}")
图生视频
import json
import requests
import time

# 1. 创建任务
url = "http://api.timiai.woa.com/ai_api_manage/hunyuan/videos/image2video"
headers = {
    'Content-Type': 'application/json',
    'Authorization': 'nZj0iy********dYSP',
}

data = {
    "model": "hunyuan-video-1.5-i2v-720p-tob-v1.0.1,
    "prompt":"仰望天空",
    "image_url":"https://aisearch.cdn.bcebos.com/pic_create/2026-01-14/16/6e58406cb7d3ad0a.jpg?x-bce-process=image/watermark,image_cGljX2NyZWF0ZS93YXRlcm1hcmsvaW1hZ2VfZWRpdF9haV9jcmVhdGVfd2F0ZXJtYXJrLnBuZw==,P_10",
    "duration": 5.0
}

response = requests.post(url, headers=headers, json=data, timeout=60)
result = response.json()

if response.status_code != 200:
    print(f"任务创建失败: {result}")
    exit()

task_id = result.get('task_id')
print(f"任务创建成功，任务ID: {task_id}")

二、查询视频任务状态
1. 接口说明
查询指定任务的生成状态和结果
Headers：Authorization（必填），使用用户个人在平台申请的API Key
2. 接口地址
正式服：
文生视频：http://api.timiai.woa.com/ai_api_manage/hunyuan/videos/text2video/query
图生视频：http://api.timiai.woa.com/ai_api_manage/hunyuan/videos/image2video/query
3. 请求参数
post请求
{
    "task_id": "xxxx"
}

4. 响应格式
执行中
{
  "id":"3c4dfb1cebdca579675326d0dcd7fce3",
  "created":1695216150,
  "status": "running",
  "videos": []
}
成功响应
{
  "id":"3c4dfb1cebdca579675326d0dcd7fce3",
  "created":1695216150,
  "status": "succeeded",
  "videos": [
    {
        "url": "xxx"
    }
  ]
}
响应字段说明：
•	created: unix时间戳
•	status:任务状态，queued, running, succeeded, failed, cancelled, unknown
•	url:视频url，有效期为24小时，生成视频长宽比与传入图片保持一致
•	id: 此次请求的id。
失败响应
{
  "error": {
    "message": "请求参数有误",
    "type": "invalid_request_error",
    "param": null,
    "code": 429,
    "id": "xxxx"
  }
}
5. 状态码说明
状态码	说明
queued	队列中
running	执行中
succeeded	执行成功
failed	失败
cancelled	取消
unknown	未知

7. Python完整示例（轮询）
import json
import requests
import time
from pathlib import Path

# 配置
API_KEY = 'nZ******AdYSP'
BASE_URL = 'http://api.timiai.woa.com/ai_api_manage'
HEADERS = {
    'Content-Type': 'application/json',
    'Authorization': API_KEY,
}

# 2. 轮询查询（最多10分钟）
url = f"{BASE_URL}/hunyuan/videos/text2video/query"
max_attempts = 90  # 最多查询90次 15分钟
poll_interval = 10  # 每10秒查询一次

print("等待任务完成...")
for attempt in range(max_attempts):
    time.sleep(poll_interval)
    response = requests.post(url, headers=HEADERS, timeout=30, json={"task_id": "xxx"})
    query_result = response.json()
    print("查询数据返回query_result:", query_result)
    status = query_result.get('result', '')
    videos = query_result.get('videos', [])
    video_urls = [video.get('url', '') for video in videos if video.get('url')]

    if status == 'succeeded':  # 成功
        print(f"任务完成! 视频生成成功")
        # 下载图片
        if len(videos) > 1:
            video_response = requests.get(video_urls[0], timeout=60)
            output_path = Path(f"vidu_output_test.mp4")
            output_path.write_bytes(video_response.content)
            print(f"视频已保存: {output_path}")
        break

    elif status == 'failed':  # 失败
        error = query_result.get('error', {})
        error_msg = error.get('error.message', '任务失败')
        print(f"任务失败: {query_result.get('ErrorMessage')}")
        break

    elif status in ['queued', 'running']:  # 新创建或执行中
        print(f"轮询 {attempt + 1}/{max_attempts}: 任务执行中...")
        continue

else:
    print("任务查询超时")
三、创建图片任务
1. 接口说明
接口类型和格式：POST接口 + json格式 body请求
Headers：Authorization（必填），使用用户个人在平台申请的API Key
2.文生图
接口地址
正式服：http://api.timiai.woa.com/ai_api_manage/hunyuan/images/generations
Body参数
参数名	说明	备注
prompt（必填）	生成图片使用的文本，字符串长度不超过8192	 
model	模型名称	必填，hunyuan-image-v3.0-v1.0.4
size	尺寸	默认是："1024x1024"。
支持的输入尺寸需满足以下约束：
1. 宽高维度均在 [512, 2048] 像素范围内;
2. 宽高乘积（即图像面积）不超过 1024×1024 像素;
seed	生成种子	仅当生成图片数为1时生效，范围[1, 4294967295]，不传或者为0时默认随机
footnote	业务自定义水印内容	限制 16 个字符长度（不区分中英文,会去换行与空格字符），生成在视频右下角。
revise	是否开启改写	false关闭，默认开启，改写预计会增加30s左右耗时。如果关闭改写，需要调用方自己接改写，否则对生图效果有较大影响，示例："revise": {"value": true}
enable_thinking	是否开启安审	开启thinking改写和生图效果会提升，但耗时会增加，最大到60s。示例："enable_thinking": {"value": true}
示例：
{
    "model": "hunyuan-image-v3.0-v1.0.4",
    "prompt": "一个小猫和一个小狗",
    "revise": {"value": true},
    "enable_thinking": {"value": false}
}
3.参考生图
接口地址
正式服：http://api.timiai.woa.com/ai_api_manage/hunyuan/images/image2image

Body参数
参数名	说明	备注	 
model	string	是	model名，固定填写 hunyuan-image-all-in-one-t2i-i2i-tob-1.0.0
messages	list	是	会话内容，长度为20，对话时间从旧到新在数组中排列。
messages[n].role	string	是	角色：“user”
messages[n].content	list[object]	是	角色说的内容。所有 content长度加起来不超过2048字符。
messages[n].content[m].type	string	否	内容的类型，text/image_url。
messages[n].content[m].text	string	否	当type为text时使用，表示具体的文本内容。
messages[n].content[m].image_url	object	是	当type为image_url时使用，表示具体的图片内容。支持 jpg/jpeg/png 图片格式。图片大小不超过 10M。
messages[n].content[m].image_url.url	string	是	参考图片对应的url放于此字段，如"/https://img.tukuppt.com/bg_grid/05/37/54/v40ZCaqERa.jpg!/fh/350/ "。

size	string	否	不填会根据内部意图分类的size进行生图，仅支持以下几个尺寸：1024x1024; 1024x768、1152x864; 768x1024、1152x864; 768x1280 ; 1280x768
style	string	否	可指定风格：宫崎骏风格，新海诚风格,去旅行风格，水彩风格，像素风格，
童话世界风格，奇趣卡通风格，赛博朋克风格，极简风格，复古风格，暗黑系风格，波普风风格，糖果色风格，胶片电影风格，素描风格，水墨画风格，油画风格，粉笔风格，粘土风格，毛毡风格，刺绣风格，彩铅风格，莫奈风格，毕加索风格，穆夏风格，古风二次元风格, 都市二次元风格, 悬疑风格, 校园风格, 都市异能风格
revise	bool	否	默认为true，为true时对prompt进行改写，实际生成的图片会使用改写后的prompt进行生成。多数场景可提升生成的图片效果。填false时，使用原prompt进行生图。
n	int	否	默认为1，生成图片个数，当前固定为1
seed	int	否	生成种子，仅当生成图片数为1时生效，范围[1, 4294967295]，不传时默认随机，当n大于1时，随机种子失效
footnote	string	否	业务自定义水印内容，限制 16 个字符长度（不区分中英文），生成在图片右下角
ignore_style_for_irag	bool	否	默认为 false，为 true 的时候忽略风格对意图分发的影响
moderation	bool	否	是否开启审核，默认是开启
intent	string	是	图生图必须填 i2i
示例：
{
     "model": "hunyuan-image-all-in-one-t2i-i2i-tob-1.0.0",
    "messages": [
        {
            "content": [
                {
                    "text": "图片中的男人身穿短裤，手戴拳套，站在UFC八角笼中",
                    "type": "text"
                },
                {
                    "image_url": {
                        "url": "http://prc-videoframe-pub-1258344703.cos.ap-guangzhou.myqcloud.com/hunyuan_img2img/editing_results_0721/result_url_seed1234_152.png"
                    },
                    "type": "image_url"
                }
            ],
            "role": "user"
        }
    ],
    "intent": "i2i",
    "moderation": false,
    "footnote": "腾讯混元"
}
4.响应格式
成功响应
{
    "id": "7bcfe2288909d5e5f4901503b07acfe5",
    "created": 1768985892,
    "data": [
        {
            "url": "xxx",
            "revised_prompt": "xxx"
        }
    ]
}
错误响应
{
  "error": {
    "message": "请求参数有误",
    "type": "invalid_request_error",
    "param": null,
    "code": "invalid_request_error",
    "id": "xxxx"
  }
}
5.Python 完整示例
文生图
import requests

# 1. 创建任务
url = "http://api.timiai.woa.com/ai_api_manage/hunyuan/images/generations"
headers = {
    'Content-Type': 'application/json',
    'Authorization': 'nZj0iy********dYSP',
}

data = {
    "model": "hunyuan-image-v3.0-v1.0.4",
    "prompt": "一个小猫和一个小狗",
    "revise": {"value": True},
    "enable_thinking": {"value": True}
}

response = requests.post(url, headers=headers, json=data, timeout=120)
result = response.json()

# {
#   "id": "9d930dbde8826f6b903922d5ee9bf7f1",
#   "created": 1739968912,
#   "data": [
#     {
#       "url": "xxx"
#     }
#   ]
# }

if response.status_code != 200:
    print(f"任务创建失败: {result}")
    exit()
images = result.get('data', [])
images_urls = [image.get('url', '') for image in images if image.get('url')]
print(f"任务创建成功，图片url: {images_urls}")
图生图
import requests

url = "http://api.timiai.woa.com/ai_api_manage/hunyuan/hunyuan/images/image2image"
headers = {
    'Content-Type': 'application/json',
    'Authorization': 'nZj0iy********dYSP',
}

data = {
     "model": "hunyuan-image-all-in-one-t2i-i2i-tob-1.0.0",
    "messages": [
        {
            "content": [
                {
                    "text": "图片中的男人身穿短裤，手戴拳套，站在UFC八角笼中",
                    "type": "text"
                },
                {
                    "image_url": {
                        "url": "http://prc-videoframe-pub-1258344703.cos.ap-guangzhou.myqcloud.com/hunyuan_img2img/editing_results_0721/result_url_seed1234_152.png"
                    },
                    "type": "image_url"
                }
            ],
            "role": "user"
        }
    ],
    "intent": "i2i",
    "moderation": False,
    "footnote": "腾讯混元"
}

response = requests.post(url, headers=headers, json=data, timeout=120)
result = response.json()

# {
#   "id": "9d930dbde8826f6b903922d5ee9bf7f1",
#   "created": 1739968912,
#   "data": [
#     {
#       "url": "xxx"
#     }
#   ]
# }

if response.status_code != 200:
    print(f"任务创建失败: {result}")
    exit()
images = result.get('data', [])
images_urls = [image.get('url', '') for image in images if image.get('url')]
print(f"任务创建成功，图片生成成功，图片URL: {images_urls}")
三、注意事项
1.	异步生成：任务提交后需轮询查询，建议每10秒查询一次，最长等待10分钟
2.	图片要求：
o	必须是可访问的HTTP/HTTPS URL，目前不支持base64格式，大小小于10M
3.	超时设置：建议创建图片任务 timeout≥120秒，查询任务 timeout≥60秒
4.	URL过期时间：返回的图片URL包含签名和过期时间（Expires参数），请及时下载保存
四、权限与资源申请
•	如没有API Key，请先申请加入对应应用组，然后创建个人API key
•	如API Key没有模型API的权限，请联系应用组管理员申请对应API模型资源
•	如需使用平台模型库未上架模型，请联系 jensli（李行健）申请和上架对应资源


