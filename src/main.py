import sounddevice as sd


def main():
    print("Dispositivos de áudio disponíveis:\n")
    print(sd.query_devices())


if __name__ == "__main__":
    main()