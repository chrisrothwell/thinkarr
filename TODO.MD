Chat Frontend
1. The first message in a new chat does not produce an answer, we have to ask the question a second time.  It instead returns a quick 200 response:
{
    "success": true,
    "data": {
        "id": "0f82e8ac-0da5-453e-87be-983e2f2a72b9",
        "userId": 1,
        "title": "New Chat",
        "createdAt": "2026-02-10T13:30:41.000Z",
        "updatedAt": "2026-02-10T13:30:41.000Z",
        "messages": [
            {
                "id": "7fad305e-00f9-4ca4-8001-d277c52326ac",
                "conversationId": "0f82e8ac-0da5-453e-87be-983e2f2a72b9",
                "role": "user",
                "content": "Is Lord of the Flies available?",
                "toolCalls": null,
                "toolCallId": null,
                "toolName": null,
                "createdAt": "2026-02-10T13:30:41.000Z"
            }
        ]
    }
}

2. New chats show up as 'Unknown' user but they can immediately be tagged to the logged in user.
3. The chat should be named immediately after the first conversation to avoid them staying as 'New Chat'.
4. The services traffic light goes amber after changing the model in the default profile but chats are working fine.

MCP

5. Review the MCPs to determine which additional tools may be needed and how best to structure the response for the LLM
- When searching for series (type: show in Plex), the most relevant metadata is the series name, year, date added, how many seasons / episodes (total), how many seasons / episodes (available), how many seasons / episodes (watched by the user)  If the user queries specific seasons or episodes, these could be returned in a JSON structure so the LLM understands which season an episode belongs to.
- The same is true of Overseerr, the most relevant metadata is the series/movie name, year, date requested, seasons requested, episode availability, next air date.  If the user request specific seasons/episodes requested, these could be returned in a JSON structure so the LLM understands which season an episode belongs to.
- radarr_list_movies and sonarr_list_series are not useful tools as they provide large JSON outputs that are likely not relevant to the user.
- radarr and sonarr are mostly useful for understanding the status of an in progress request - is it downloading, how many minutes left, next episode dates and whether it is monitored.

Settings frontend
4. Testing the connection for Plex & Arrs gives erorr: type, url, and apiKey are required
5. The default system prompt (system-prompt.ts) should pre-fill in the system prompt box and be stored in the database. Some format should be used for the serviceList variable.
5. Plex should not get a token via Plex Login, it should search and discover local servers via IP address like Overseerr
6. Testing the connection for LLM variously gives error: type, url, and apiKey are required or something about Max-something not supported by the model endpoint.
7. There is no option to set any of the LLM models as default. One (any one, but only one) should be allowed to be toggled as default.
8. In User Management, the first user to register (Master Administrator) should not be allowed to be made a user.
