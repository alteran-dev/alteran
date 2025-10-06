package cuenv

env: {
	environment: test: {
		REFRESH_TOKEN: "access-secret"
		PDS_DID: "did:example:test"
		PDS_HANDLE: "test"
		REFRESH_TOKEN_SECRET: "refresh-secret"
		USER_PASSWORD: "pwd"
	}
}

tasks: {
	test: {
		command: "printenv"
	}
}
