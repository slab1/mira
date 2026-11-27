# Simple Console Text Adventure in Python

def display_room(room):
    print("-" * 40)
    print(f"Location: {room['name']}")
    print(room['description'])
    print("Exits available: " + ", ".join(room['exits'].keys()))
    print("-" * 40)

def setup_game():
    rooms = {
        'entrance': {
            'name': "Entrance Hall",
            'description': "You stand in a dusty entrance hall. A cold wind blows from the north, and a passage leads east.",
            'exits': {'north': 'forest', 'east': 'kitchen'}
        },
        'forest': {
            'name': "Dark Forest",
            'description': "Giant, ancient trees loom overhead. The path back south is clear, and a faint light glows to the east.",
            'exits': {'south': 'entrance', 'east': 'clearing'}
        },
        'kitchen': {
            'name': "Crusty Kitchen",
            'description': "The kitchen is dimly lit and smells of old spices. You can return west to the entrance.",
            'exits': {'west': 'entrance'}
        },
        'clearing': {
            'name': "Sunlit Clearing",
            'description': "A small, sunlit clearing offers a brief respite. From here, you can only go back west.",
            'exits': {'west': 'forest'}
        }
    }

    current_room = 'entrance'
    game_over = False

    print("=========================================")
    print("🌟 Console Adventure: The Dusty Hall 🌟")
    print("=========================================")
    print("Welcome! Type 'help' for commands.")
    display_room(rooms[current_room])

    while not game_over:
        try:
            command = input("> ").strip().lower()
            if not command:
                continue

            parts = command.split()
            action = parts[0]
            argument = ' '.join(parts[1:]) if len(parts) > 1 else None

            if action in ['quit', 'exit']:
                print("Thanks for playing! Goodbye.")
                game_over = True
            elif action == 'help':
                print("Commands: go [direction], look, quit, help")
            elif action == 'look':
                display_room(rooms[current_room])
            elif action == 'go':
                if argument and argument in rooms[current_room]['exits']:
                    next_room_key = rooms[current_room]['exits'][argument]
                    current_room = next_room_key
                    display_room(rooms[current_room])
                else:
                    print("Cannot go that way. Check the exits.")
            else:
                print("Unknown command. Type 'help'.")

        except EOFError:
            print("\nExiting game.")
            game_over = True
        except KeyboardInterrupt:
            print("\nGame interrupted. Goodbye.")
            game_over = True

if __name__ == "__main__":
    setup_game()
