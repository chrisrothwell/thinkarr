## Completed

1. [x] Create a dev branch and a features branch. Use main for production ready merges only.

2. [x] BUG - When checking episode information in Plex, the MCP needs to return the season number along with the episode details to faciliate better querying.

3. [x] BUG - During a conversation, the chat history displays correctly, but when opening a historic conversation, the tool call may appear twice, and there is an unnecessary div after each tool call with the pulsing cursor as if waiting for a response.

4. [x] FEATURE - When connecting to Plex, we shouldn't require a Token. Implemented "Discover Servers" button in settings that queries plex.tv/api/v2/resources using the admin's linked Plex account token, returns a list of servers, and auto-fills URL and access token when one is selected. Manual entry preserved as fallback.

5. [x] FEATURE - After saving settings during the initial welcome setup, if critical settings are complete (successful model connection, plex connected) it offers to redirect to the main chat interface with a 5s option to cancel. If the user tries to exit the setup screen when its not fully configured, it shows "Are you sure?" before allowing the user to exit.

7. [x] FEATURE - Only users who are added to a shared media library in Plex can register. Users who are not registered for the shared media library get an error message "You do not have access to any media on this server, please contact the owner to get access to a Shared Library." Check fails closed (denies) if Plex server is unreachable. First user (admin) always passes.

8. [x] FEATURE - Per-user rate limiting added. Default 100 messages per day, configurable to X messages per Y (hour, day, week, month) in the Settings > Users tab. If users exceed their rate limit, they see a message in chat: "Your Session Limit has expired and will refresh on DD/MMM/YY HH:MM".

---

## Pending

6. FEATURE - Create a card in the chat interface which displays a specific title or titles in a standard format in the chat interface.  It should include the artwork thumbnail, and basic information about the title (name, release date, summary, key cast, starring, rating, availability in library, and anything else you think is useful).  If multiple titles are returned it should be in a carousel format.  If the title is not yet available, a request button should allow the user to request the item.  If the title is available, a button should allow the user to watch now (launches Plex).  This should handle both movies and series (each episode is considered a title.)  When dealing with series, the results should always be returned in order of air date.

9. MAJOR FEATURE - I'd like to add WhatsApp integration.  Create a new tab in the Settings screen for WhatsApp integration to provide the Meta Cloud API Key.  The Users tab should have a Phone Number field so users can be identified when they use WhatsApp to send a message and chat history will be assigned to that user.  When a user who is not registered for the platform sends a message, the bot should respond with a link to the web interface to sign in with Plex.  New users must provide a phone number (optional) if they wish to converse via WhatsApp.  Users can change their phone number in Settings.  Sessions created via WhatsApp should have a 24 hour limit.  The bot should respond when it is @ messaged "@Thinkarr" and replies should be sent as quoted replies.  WhatsApp messages will also need to handle the card/carousel concept for titles (send the thumbnail as images, and use interactive buttons for request / watch).  As the WhatsApp bot may exist in Groups, one person may request a title but another person may click the button to request the title and it may be requested multiple times (the tool call should handle this gracefully and explain the title has already been requested.)

10. FEATURE - Let's add best practice logging.  Application initialization logs should be written to stdio to be picked up by Docker Logs.  Application run logs should be written within the container and persisted in the shared volume config.  Logs should be rotated.  Add a logs tab in Settings to enable the log files to be viewed and downloaded.
